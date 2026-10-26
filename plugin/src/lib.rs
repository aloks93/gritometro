// Gritómetro Procesador as a VST3 / CLAP plugin: the app's processing chain (noise reduction,
// gate, parametric EQ, de-esser, two compressors, saturation, look-ahead limiter) inside a DAW,
// with the app's presets and preset files.

use atomic_float::AtomicF32;
use nih_plug::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub mod dsp;
mod editor;
pub mod params;
pub mod presets;

use dsp::{resample_profile, Chain};
use params::ProcParams;

/// Seconds of silence captured by "Aprender ruido"
pub const LEARN_SECONDS: f32 = 2.0;

/// State shared between the audio thread and the editor
pub struct Shared {
    /// Peak levels and reductions since the editor last read them (dB)
    pub in_peak: AtomicF32,
    pub out_peak: AtomicF32,
    pub noise_db: AtomicF32,
    pub gate_db: AtomicF32,
    pub deess_gr: AtomicF32,
    pub comp1_gr: AtomicF32,
    pub comp2_gr: AtomicF32,
    pub lim_gr: AtomicF32,
    pub sample_rate: AtomicF32,
    /// Editor → audio: start learning the noise profile
    pub learn_request: AtomicBool,
    /// Audio → editor: a learning run is in progress
    pub learning: AtomicBool,
    /// Editor → audio: the stored profile changed (imported), reload it
    pub profile_dirty: AtomicBool,
    /// Latest input / output samples of the first channel, for the editor's spectrum
    pub scope_in: Mutex<Scope>,
    pub scope_out: Mutex<Scope>,
}

/// Ring of the last SCOPE_SIZE samples
pub struct Scope {
    pub buf: Vec<f32>,
    pub pos: usize,
}

pub const SCOPE_SIZE: usize = 4096;

impl Scope {
    fn new() -> Self {
        Self { buf: vec![0.0; SCOPE_SIZE], pos: 0 }
    }

    fn push(&mut self, data: &[f32]) {
        for &x in data {
            self.buf[self.pos] = x;
            self.pos = (self.pos + 1) % SCOPE_SIZE;
        }
    }

    /// The samples in time order
    pub fn ordered(&self, out: &mut [f32]) {
        for (i, o) in out.iter_mut().enumerate().take(SCOPE_SIZE) {
            *o = self.buf[(self.pos + i) % SCOPE_SIZE];
        }
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            in_peak: AtomicF32::new(-100.0),
            out_peak: AtomicF32::new(-100.0),
            noise_db: AtomicF32::new(0.0),
            gate_db: AtomicF32::new(0.0),
            deess_gr: AtomicF32::new(0.0),
            comp1_gr: AtomicF32::new(0.0),
            comp2_gr: AtomicF32::new(0.0),
            lim_gr: AtomicF32::new(0.0),
            sample_rate: AtomicF32::new(48000.0),
            learn_request: AtomicBool::new(false),
            learning: AtomicBool::new(false),
            profile_dirty: AtomicBool::new(true),
            scope_in: Mutex::new(Scope::new()),
            scope_out: Mutex::new(Scope::new()),
        }
    }
}

/// Keeps the loudest (or deepest) value until the editor takes it
fn hold_max(a: &AtomicF32, v: f32) {
    if v > a.load(Ordering::Relaxed) {
        a.store(v, Ordering::Relaxed);
    }
}

fn hold_min(a: &AtomicF32, v: f32) {
    if v < a.load(Ordering::Relaxed) {
        a.store(v, Ordering::Relaxed);
    }
}

fn peak_db(buf: &[f32]) -> f32 {
    dsp::lin_to_db(buf.iter().fold(0.0f32, |m, &x| m.max(x.abs())))
}

pub struct GritProcesador {
    params: Arc<ProcParams>,
    shared: Arc<Shared>,
    /// One independent chain per channel (a mono track in a stereo slot gets identical processing)
    chains: Vec<Chain>,
}

impl Default for GritProcesador {
    fn default() -> Self {
        Self { params: Arc::new(ProcParams::default()), shared: Arc::new(Shared::default()), chains: Vec::new() }
    }
}

impl GritProcesador {
    fn load_profile(&mut self) {
        let Ok(stored) = self.params.noise_profile.try_read() else { return };
        for c in self.chains.iter_mut() {
            let bins = c.noise.bins();
            c.noise.set_profile(if stored.len() > 1 { Some(resample_profile(&stored, bins)) } else { None });
        }
    }
}

impl Plugin for GritProcesador {
    const NAME: &'static str = "Gritometro Procesador";
    const VENDOR: &'static str = "Gritometro";
    const URL: &'static str = "https://github.com/aloks93/gritometro";
    const EMAIL: &'static str = "";
    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    const AUDIO_IO_LAYOUTS: &'static [AudioIOLayout] = &[
        AudioIOLayout { main_input_channels: NonZeroU32::new(2), main_output_channels: NonZeroU32::new(2), ..AudioIOLayout::const_default() },
        AudioIOLayout { main_input_channels: NonZeroU32::new(1), main_output_channels: NonZeroU32::new(1), ..AudioIOLayout::const_default() },
    ];

    const SAMPLE_ACCURATE_AUTOMATION: bool = false;

    type SysExMessage = ();
    type BackgroundTask = ();

    fn params(&self) -> Arc<dyn Params> {
        self.params.clone()
    }

    fn editor(&mut self, _async_executor: AsyncExecutor<Self>) -> Option<Box<dyn Editor>> {
        editor::create(self.params.clone(), self.shared.clone())
    }

    fn initialize(&mut self, layout: &AudioIOLayout, config: &BufferConfig, context: &mut impl InitContext<Self>) -> bool {
        let channels = layout.main_output_channels.map(|c| c.get()).unwrap_or(2) as usize;
        let sr = config.sample_rate;
        self.chains = (0..channels).map(|_| Chain::new(sr)).collect();
        self.shared.sample_rate.store(sr, Ordering::Relaxed);
        self.load_profile();
        context.set_latency_samples(self.chains[0].latency() as u32);
        true
    }

    fn reset(&mut self) {
        let sr = self.shared.sample_rate.load(Ordering::Relaxed);
        let n = self.chains.len();
        self.chains = (0..n).map(|_| Chain::new(sr)).collect();
        self.load_profile();
    }

    fn process(&mut self, buffer: &mut Buffer, _aux: &mut AuxiliaryBuffers, _context: &mut impl ProcessContext<Self>) -> ProcessStatus {
        if self.shared.profile_dirty.swap(false, Ordering::Relaxed) {
            nih_plug::util::permit_alloc(|| self.load_profile());
        }
        if self.shared.learn_request.swap(false, Ordering::Relaxed) {
            self.chains.iter_mut().for_each(|c| c.noise.learn(LEARN_SECONDS));
        }
        let settings = self.params.settings();
        let gui = self.params.editor_state.is_open();
        let sh = &self.shared;
        for (ch, data) in buffer.as_slice().iter_mut().enumerate() {
            let Some(chain) = self.chains.get_mut(ch) else { continue };
            if gui {
                hold_max(&sh.in_peak, peak_db(data));
                // Never blocks: if the editor is reading, this block is simply skipped
                if ch == 0 {
                    if let Ok(mut s) = sh.scope_in.try_lock() {
                        s.push(data);
                    }
                }
            }
            let r = chain.process(data, &settings);
            if gui {
                hold_max(&sh.out_peak, peak_db(data));
                if ch == 0 {
                    if let Ok(mut s) = sh.scope_out.try_lock() {
                        s.push(data);
                    }
                }
                hold_min(&sh.noise_db, r.noise_db);
                hold_min(&sh.gate_db, r.gate_db);
                hold_min(&sh.deess_gr, r.deess_gr);
                hold_min(&sh.comp1_gr, r.comp1_gr);
                hold_min(&sh.comp2_gr, r.comp2_gr);
                hold_min(&sh.lim_gr, r.lim_gr);
            }
        }
        // A finished capture becomes the stored (saved with the project) profile
        let learning = self.chains.iter().any(|c| c.noise.learning());
        sh.learning.store(learning, Ordering::Relaxed);
        if let Some(profile) = self.chains.first_mut().and_then(|c| c.noise.learned_profile.take()) {
            nih_plug::util::permit_alloc(|| {
                if let Ok(mut stored) = self.params.noise_profile.try_write() {
                    *stored = profile;
                }
            });
        }
        ProcessStatus::Normal
    }
}

impl ClapPlugin for GritProcesador {
    const CLAP_ID: &'static str = "com.gritometro.procesador";
    const CLAP_DESCRIPTION: Option<&'static str> = Some("Noise reduction, gate, parametric EQ, de-esser, compressors, saturation and limiter for voices and instruments");
    const CLAP_MANUAL_URL: Option<&'static str> = Some(Self::URL);
    const CLAP_SUPPORT_URL: Option<&'static str> = None;
    const CLAP_FEATURES: &'static [ClapFeature] = &[ClapFeature::AudioEffect, ClapFeature::Mono, ClapFeature::Stereo, ClapFeature::Compressor, ClapFeature::Equalizer, ClapFeature::Restoration];
}

impl Vst3Plugin for GritProcesador {
    const VST3_CLASS_ID: [u8; 16] = *b"GritometroProcVS";
    const VST3_SUBCATEGORIES: &'static [Vst3SubCategory] = &[Vst3SubCategory::Fx, Vst3SubCategory::Dynamics, Vst3SubCategory::Eq, Vst3SubCategory::Restoration];
}

nih_export_clap!(GritProcesador);
nih_export_vst3!(GritProcesador);
