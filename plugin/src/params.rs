// Plugin parameters: the same controls and ranges as the knobs of the app's processor
// (src/renderer/src/ui/studio/ProcessorView.tsx), with the app's defaults.

use crate::dsp::*;
use nih_plug::prelude::*;
use nih_plug_egui::EguiState;
use std::sync::{Arc, RwLock};

#[derive(Enum, Debug, PartialEq, Clone, Copy)]
pub enum GateModeP {
    #[id = "expander"]
    #[name = "Expansor"]
    Expander,
    #[id = "gate"]
    #[name = "Puerta"]
    Gate,
}

#[derive(Enum, Debug, PartialEq, Clone, Copy)]
pub enum NoiseModeP {
    #[id = "adaptive"]
    #[name = "Adaptativa"]
    Adaptive,
    #[id = "learned"]
    #[name = "Perfil aprendido"]
    Learned,
}

#[derive(Enum, Debug, PartialEq, Clone, Copy)]
pub enum DeEssModeP {
    #[id = "split"]
    #[name = "Solo agudos"]
    Split,
    #[id = "wide"]
    #[name = "Banda ancha"]
    Wide,
}

#[derive(Enum, Debug, PartialEq, Clone, Copy)]
pub enum DetectorP {
    #[id = "peak"]
    #[name = "Pico"]
    Peak,
    #[id = "rms"]
    #[name = "RMS"]
    Rms,
}

#[derive(Enum, Debug, PartialEq, Clone, Copy)]
pub enum SatModeP {
    #[id = "tube"]
    #[name = "Válvula"]
    Tube,
    #[id = "tape"]
    #[name = "Cinta"]
    Tape,
    #[id = "amp"]
    #[name = "Ampli"]
    Amp,
}

#[derive(Enum, Debug, PartialEq, Clone, Copy)]
pub enum BandTypeP {
    #[id = "peaking"]
    #[name = "Campana"]
    Peaking,
    #[id = "lowshelf"]
    #[name = "Shelf graves"]
    LowShelf,
    #[id = "highshelf"]
    #[name = "Shelf agudos"]
    HighShelf,
    #[id = "highpass"]
    #[name = "Paso alto"]
    Highpass,
    #[id = "lowpass"]
    #[name = "Paso bajo"]
    Lowpass,
    #[id = "notch"]
    #[name = "Notch"]
    Notch,
    #[id = "bandpass"]
    #[name = "Paso banda"]
    Bandpass,
}

#[derive(Enum, Debug, PartialEq, Clone, Copy)]
pub enum SlopeP {
    #[id = "12"]
    #[name = "12 dB/oct"]
    S12,
    #[id = "24"]
    #[name = "24 dB/oct"]
    S24,
    #[id = "36"]
    #[name = "36 dB/oct"]
    S36,
    #[id = "48"]
    #[name = "48 dB/oct"]
    S48,
}

impl BandTypeP {
    pub fn dsp(self) -> BandType {
        match self {
            BandTypeP::Peaking => BandType::Peaking,
            BandTypeP::LowShelf => BandType::LowShelf,
            BandTypeP::HighShelf => BandType::HighShelf,
            BandTypeP::Highpass => BandType::Highpass,
            BandTypeP::Lowpass => BandType::Lowpass,
            BandTypeP::Notch => BandType::Notch,
            BandTypeP::Bandpass => BandType::Bandpass,
        }
    }
    pub fn from_app(s: &str) -> Self {
        match s {
            "lowshelf" => BandTypeP::LowShelf,
            "highshelf" => BandTypeP::HighShelf,
            "highpass" => BandTypeP::Highpass,
            "lowpass" => BandTypeP::Lowpass,
            "notch" => BandTypeP::Notch,
            "bandpass" => BandTypeP::Bandpass,
            _ => BandTypeP::Peaking,
        }
    }
    pub fn to_app(self) -> &'static str {
        match self {
            BandTypeP::Peaking => "peaking",
            BandTypeP::LowShelf => "lowshelf",
            BandTypeP::HighShelf => "highshelf",
            BandTypeP::Highpass => "highpass",
            BandTypeP::Lowpass => "lowpass",
            BandTypeP::Notch => "notch",
            BandTypeP::Bandpass => "bandpass",
        }
    }
}

impl SlopeP {
    pub fn db(self) -> u32 {
        match self {
            SlopeP::S12 => 12,
            SlopeP::S24 => 24,
            SlopeP::S36 => 36,
            SlopeP::S48 => 48,
        }
    }
    pub fn from_db(db: u32) -> Self {
        match db {
            24 => SlopeP::S24,
            36 => SlopeP::S36,
            48 => SlopeP::S48,
            _ => SlopeP::S12,
        }
    }
}

// ---- Range helpers

fn db(name: &str, def: f32, min: f32, max: f32) -> FloatParam {
    FloatParam::new(name, def, FloatRange::Linear { min, max }).with_step_size(0.1).with_unit(" dB").with_value_to_string(formatters::v2s_f32_rounded(1))
}

fn lin(name: &str, def: f32, min: f32, max: f32, unit: &'static str) -> FloatParam {
    FloatParam::new(name, def, FloatRange::Linear { min, max }).with_step_size(0.1).with_unit(unit).with_value_to_string(formatters::v2s_f32_rounded(1))
}

fn log(name: &str, def: f32, min: f32, max: f32, unit: &'static str) -> FloatParam {
    FloatParam::new(name, def, FloatRange::Skewed { min, max, factor: FloatRange::skew_factor(-2.0) }).with_unit(unit).with_value_to_string(formatters::v2s_f32_rounded(2))
}

fn hz(name: &str, def: f32, min: f32, max: f32) -> FloatParam {
    // The formatter writes its own unit (Hz or kHz)
    FloatParam::new(name, def, FloatRange::Skewed { min, max, factor: FloatRange::skew_factor(-2.0) })
        .with_value_to_string(formatters::v2s_f32_hz_then_khz(1))
        .with_string_to_value(formatters::s2v_f32_hz_then_khz())
}

/// A frequency where 0 means "off" (detector / sidechain filters)
fn hz_off(name: &str, max: f32) -> FloatParam {
    FloatParam::new(name, 0.0, FloatRange::Skewed { min: 0.0, max, factor: FloatRange::skew_factor(-2.0) })
        .with_value_to_string(Arc::new(|v| if v < 20.0 { "OFF".to_string() } else { format!("{v:.0} Hz") }))
        .with_string_to_value(Arc::new(|s| {
            let t = s.trim();
            if t.eq_ignore_ascii_case("off") {
                return Some(0.0);
            }
            t.trim_end_matches(|c: char| c.is_alphabetic() || c.is_whitespace()).parse::<f32>().ok()
        }))
}

fn pct(name: &str, def: f32) -> FloatParam {
    FloatParam::new(name, def, FloatRange::Linear { min: 0.0, max: 100.0 }).with_step_size(1.0).with_unit(" %").with_value_to_string(formatters::v2s_f32_rounded(0))
}

/// Values below 20 Hz on an "off" frequency read as off
pub fn off_hz(v: f32) -> f32 {
    if v < 20.0 {
        0.0
    } else {
        v
    }
}

// ---- Groups

#[derive(Params)]
pub struct NoiseParams {
    #[id = "nr_on"]
    pub on: BoolParam,
    #[id = "nr_mode"]
    pub mode: EnumParam<NoiseModeP>,
    #[id = "nr_red"]
    pub reduction: FloatParam,
    #[id = "nr_sens"]
    pub sensitivity: FloatParam,
    #[id = "nr_smooth"]
    pub smoothing: FloatParam,
    #[id = "nr_from"]
    pub from_hz: FloatParam,
    #[id = "nr_listen"]
    pub listen_removed: BoolParam,
}

#[derive(Params)]
pub struct GateParams {
    #[id = "gt_on"]
    pub on: BoolParam,
    #[id = "gt_mode"]
    pub mode: EnumParam<GateModeP>,
    #[id = "gt_thr"]
    pub threshold: FloatParam,
    #[id = "gt_hyst"]
    pub hysteresis: FloatParam,
    #[id = "gt_range"]
    pub range: FloatParam,
    #[id = "gt_ratio"]
    pub ratio: FloatParam,
    #[id = "gt_att"]
    pub attack: FloatParam,
    #[id = "gt_hold"]
    pub hold: FloatParam,
    #[id = "gt_rel"]
    pub release: FloatParam,
    #[id = "gt_khpf"]
    pub key_hpf: FloatParam,
    #[id = "gt_klpf"]
    pub key_lpf: FloatParam,
}

#[derive(Params)]
pub struct BandParams {
    #[id = "on"]
    pub on: BoolParam,
    #[id = "type"]
    pub kind: EnumParam<BandTypeP>,
    #[id = "freq"]
    pub freq: FloatParam,
    #[id = "gain"]
    pub gain: FloatParam,
    #[id = "q"]
    pub q: FloatParam,
    #[id = "slope"]
    pub slope: EnumParam<SlopeP>,
}

#[derive(Params)]
pub struct DeEsserParams {
    #[id = "ds_on"]
    pub on: BoolParam,
    #[id = "ds_mode"]
    pub mode: EnumParam<DeEssModeP>,
    #[id = "ds_freq"]
    pub freq: FloatParam,
    #[id = "ds_q"]
    pub q: FloatParam,
    #[id = "ds_thr"]
    pub threshold: FloatParam,
    #[id = "ds_ratio"]
    pub ratio: FloatParam,
    #[id = "ds_range"]
    pub range: FloatParam,
    #[id = "ds_listen"]
    pub listen: BoolParam,
}

#[derive(Params)]
pub struct CompParams {
    #[id = "on"]
    pub on: BoolParam,
    #[id = "thr"]
    pub threshold: FloatParam,
    #[id = "ratio"]
    pub ratio: FloatParam,
    #[id = "knee"]
    pub knee: FloatParam,
    #[id = "att"]
    pub attack: FloatParam,
    #[id = "rel"]
    pub release: FloatParam,
    #[id = "makeup"]
    pub makeup: FloatParam,
    #[id = "auto"]
    pub auto_makeup: BoolParam,
    #[id = "mix"]
    pub mix: FloatParam,
    #[id = "det"]
    pub detector: EnumParam<DetectorP>,
    #[id = "schpf"]
    pub sc_hpf: FloatParam,
}

#[derive(Params)]
pub struct SatParams {
    #[id = "st_on"]
    pub on: BoolParam,
    #[id = "st_mode"]
    pub mode: EnumParam<SatModeP>,
    #[id = "st_drive"]
    pub drive: FloatParam,
    #[id = "st_tone"]
    pub tone: FloatParam,
    #[id = "st_mix"]
    pub mix: FloatParam,
}

#[derive(Params)]
pub struct LimiterParams {
    #[id = "lm_on"]
    pub on: BoolParam,
    #[id = "lm_ceil"]
    pub ceiling: FloatParam,
    #[id = "lm_rel"]
    pub release: FloatParam,
}

#[derive(Params)]
pub struct ProcParams {
    #[persist = "editor-state"]
    pub editor_state: Arc<EguiState>,
    /// Learned noise profile (power per bin of the 1024-point FFT), empty = none
    #[persist = "noise-profile"]
    pub noise_profile: Arc<RwLock<Vec<f32>>>,
    /// Name of the last preset loaded or saved, shown in the editor
    #[persist = "preset-name"]
    pub preset_name: Arc<RwLock<String>>,

    #[id = "in_gain"]
    pub input_gain: FloatParam,
    #[id = "phase"]
    pub phase_invert: BoolParam,
    #[id = "out_gain"]
    pub output_gain: FloatParam,
    #[nested(group = "Reducción de ruido")]
    pub noise: NoiseParams,
    #[nested(group = "Puerta y expansor")]
    pub gate: GateParams,
    #[id = "eq_on"]
    pub eq_on: BoolParam,
    #[id = "eq_post"]
    pub eq_post: BoolParam,
    #[nested(array, group = "Ecualizador")]
    pub bands: [BandParams; MAX_BANDS],
    #[nested(group = "De-esser")]
    pub deesser: DeEsserParams,
    #[nested(id_prefix = "c1", group = "Compresor 1")]
    pub comp1: CompParams,
    #[nested(id_prefix = "c2", group = "Compresor 2")]
    pub comp2: CompParams,
    #[nested(group = "Saturador")]
    pub saturation: SatParams,
    #[nested(group = "Limitador")]
    pub limiter: LimiterParams,
}

/// The app's default eight bands (defaultBands in processor.ts)
pub const DEFAULT_BANDS: [(BandTypeP, f32, f32, bool, SlopeP); MAX_BANDS] = [
    (BandTypeP::Highpass, 80.0, 0.71, true, SlopeP::S24),
    (BandTypeP::LowShelf, 150.0, 1.0, true, SlopeP::S12),
    (BandTypeP::Peaking, 300.0, 1.2, true, SlopeP::S12),
    (BandTypeP::Peaking, 800.0, 1.4, true, SlopeP::S12),
    (BandTypeP::Peaking, 3000.0, 1.0, true, SlopeP::S12),
    (BandTypeP::Peaking, 6500.0, 3.0, true, SlopeP::S12),
    (BandTypeP::HighShelf, 10000.0, 1.0, true, SlopeP::S12),
    (BandTypeP::Lowpass, 18000.0, 0.71, false, SlopeP::S12),
];

impl CompParams {
    fn new(name: &str, thr: f32, ratio: f32, knee: f32, att: f32, rel: f32, makeup: f32, det: DetectorP) -> Self {
        Self {
            on: BoolParam::new(format!("{name} activo"), false),
            threshold: db(&format!("{name} umbral"), thr, -60.0, 0.0),
            ratio: log(&format!("{name} ratio"), ratio, 1.0, 20.0, ":1"),
            knee: db(&format!("{name} rodilla"), knee, 0.0, 24.0),
            attack: log(&format!("{name} ataque"), att, 0.1, 200.0, " ms"),
            release: log(&format!("{name} liberación"), rel, 10.0, 2000.0, " ms"),
            makeup: db(&format!("{name} compensación"), makeup, -12.0, 24.0),
            auto_makeup: BoolParam::new(format!("{name} auto gain"), false),
            mix: pct(&format!("{name} mezcla"), 100.0),
            detector: EnumParam::new(format!("{name} detector"), det),
            sc_hpf: hz_off(&format!("{name} SC HPF"), 500.0),
        }
    }

    fn settings(&self) -> CompSettings {
        CompSettings {
            on: self.on.value(),
            threshold_db: self.threshold.value(),
            ratio: self.ratio.value(),
            knee_db: self.knee.value(),
            attack_ms: self.attack.value(),
            release_ms: self.release.value(),
            makeup_db: self.makeup.value(),
            auto_makeup: self.auto_makeup.value(),
            mix: self.mix.value(),
            detector: if self.detector.value() == DetectorP::Rms { Detector::Rms } else { Detector::Peak },
            sc_hpf_hz: off_hz(self.sc_hpf.value()),
        }
    }
}

impl Default for ProcParams {
    fn default() -> Self {
        let bands = std::array::from_fn(|i| {
            let (kind, freq, q, on, slope) = DEFAULT_BANDS[i];
            let n = i + 1;
            BandParams {
                on: BoolParam::new(format!("Banda {n} activa"), on),
                kind: EnumParam::new(format!("Banda {n} tipo"), kind),
                freq: hz(&format!("Banda {n} frecuencia"), freq, 20.0, 20000.0),
                gain: db(&format!("Banda {n} ganancia"), 0.0, -24.0, 24.0),
                q: log(&format!("Banda {n} Q"), q, 0.1, 20.0, ""),
                slope: EnumParam::new(format!("Banda {n} pendiente"), slope),
            }
        });
        Self {
            editor_state: EguiState::from_size(1200, 840),
            noise_profile: Arc::new(RwLock::new(Vec::new())),
            preset_name: Arc::new(RwLock::new(String::new())),
            input_gain: db("Ganancia de entrada", 0.0, -24.0, 36.0),
            phase_invert: BoolParam::new("Invertir fase", false),
            output_gain: db("Ganancia de salida", 0.0, -24.0, 24.0),
            noise: NoiseParams {
                on: BoolParam::new("Ruido activo", false),
                mode: EnumParam::new("Ruido modo", NoiseModeP::Adaptive),
                reduction: db("Ruido reducción", -18.0, -40.0, 0.0),
                sensitivity: db("Ruido sensibilidad", 0.0, -10.0, 10.0),
                smoothing: pct("Ruido suavizado", 50.0),
                from_hz: hz_off("Ruido desde", 2000.0),
                listen_removed: BoolParam::new("Ruido escuchar eliminado", false),
            },
            gate: GateParams {
                on: BoolParam::new("Puerta activa", false),
                mode: EnumParam::new("Puerta modo", GateModeP::Expander),
                threshold: db("Puerta umbral", -50.0, -90.0, -10.0),
                hysteresis: db("Puerta histéresis", 4.0, 0.0, 20.0),
                range: db("Puerta rango", -30.0, -80.0, 0.0),
                ratio: lin("Puerta ratio", 2.0, 1.0, 10.0, ":1"),
                attack: log("Puerta ataque", 1.0, 0.1, 50.0, " ms"),
                hold: lin("Puerta mantener", 120.0, 0.0, 1000.0, " ms"),
                release: log("Puerta liberación", 180.0, 5.0, 2000.0, " ms"),
                key_hpf: hz_off("Puerta clave HPF", 1000.0),
                key_lpf: hz_off("Puerta clave LPF", 20000.0),
            },
            eq_on: BoolParam::new("EQ activo", true),
            eq_post: BoolParam::new("EQ después de compresores", false),
            bands,
            deesser: DeEsserParams {
                on: BoolParam::new("De-esser activo", false),
                mode: EnumParam::new("De-esser modo", DeEssModeP::Split),
                freq: hz("De-esser frecuencia", 6500.0, 2000.0, 12000.0),
                q: log("De-esser ancho", 1.4, 0.5, 5.0, ""),
                threshold: db("De-esser umbral", -30.0, -60.0, 0.0),
                ratio: lin("De-esser ratio", 4.0, 1.0, 10.0, ":1"),
                range: db("De-esser reducción máx.", -8.0, -24.0, 0.0),
                listen: BoolParam::new("De-esser escucha", false),
            },
            comp1: CompParams::new("Comp 1", -18.0, 4.0, 6.0, 5.0, 80.0, 4.0, DetectorP::Peak),
            comp2: CompParams::new("Comp 2", -24.0, 2.0, 10.0, 30.0, 400.0, 2.0, DetectorP::Rms),
            saturation: SatParams {
                on: BoolParam::new("Saturador activo", false),
                mode: EnumParam::new("Saturador modo", SatModeP::Tube),
                drive: db("Saturador drive", 6.0, 0.0, 36.0),
                tone: hz("Saturador tono", 12000.0, 2000.0, 20000.0),
                mix: pct("Saturador mezcla", 35.0),
            },
            limiter: LimiterParams {
                on: BoolParam::new("Limitador activo", true),
                ceiling: db("Limitador techo", -1.0, -12.0, 0.0).with_unit(" dBTP"),
                release: log("Limitador liberación", 60.0, 10.0, 1000.0, " ms"),
            },
        }
    }
}

impl ProcParams {
    pub fn band_settings(&self) -> [BandSettings; MAX_BANDS] {
        std::array::from_fn(|i| {
            let b = &self.bands[i];
            BandSettings { on: b.on.value(), kind: b.kind.value().dsp(), freq: b.freq.value(), gain_db: b.gain.value(), q: b.q.value(), slope: b.slope.value().db() }
        })
    }

    /// Everything the DSP needs, read once per block (no allocation)
    pub fn settings(&self) -> ChainSettings {
        let n = &self.noise;
        let g = &self.gate;
        let d = &self.deesser;
        let s = &self.saturation;
        ChainSettings {
            input_gain_db: self.input_gain.value(),
            phase_invert: self.phase_invert.value(),
            noise: NoiseSettings {
                on: n.on.value(),
                mode: if n.mode.value() == NoiseModeP::Learned { NoiseMode::Learned } else { NoiseMode::Adaptive },
                reduction_db: n.reduction.value(),
                sensitivity_db: n.sensitivity.value(),
                smoothing: n.smoothing.value(),
                from_hz: off_hz(n.from_hz.value()),
                listen_removed: n.listen_removed.value(),
            },
            gate: GateSettings {
                on: g.on.value(),
                mode: if g.mode.value() == GateModeP::Gate { GateMode::Gate } else { GateMode::Expander },
                threshold_db: g.threshold.value(),
                hysteresis_db: g.hysteresis.value(),
                range_db: g.range.value(),
                ratio: g.ratio.value(),
                attack_ms: g.attack.value(),
                hold_ms: g.hold.value(),
                release_ms: g.release.value(),
                key_hpf_hz: off_hz(g.key_hpf.value()),
                key_lpf_hz: off_hz(g.key_lpf.value()),
            },
            eq_on: self.eq_on.value(),
            eq_post: self.eq_post.value(),
            bands: self.band_settings(),
            deesser: DeEsserSettings {
                on: d.on.value(),
                freq: d.freq.value(),
                q: d.q.value(),
                threshold_db: d.threshold.value(),
                ratio: d.ratio.value(),
                range_db: d.range.value(),
                mode: if d.mode.value() == DeEssModeP::Wide { DeEssMode::Wide } else { DeEssMode::Split },
                listen: d.listen.value(),
            },
            comp1: self.comp1.settings(),
            comp2: self.comp2.settings(),
            saturation: SatSettings {
                on: s.on.value(),
                mode: match s.mode.value() {
                    SatModeP::Tube => SatMode::Tube,
                    SatModeP::Tape => SatMode::Tape,
                    SatModeP::Amp => SatMode::Amp,
                },
                drive_db: s.drive.value(),
                tone_hz: s.tone.value(),
                mix: s.mix.value(),
            },
            limiter: LimiterSettings { on: self.limiter.on.value(), ceiling_db: self.limiter.ceiling.value(), release_ms: self.limiter.release.value() },
            output_gain_db: self.output_gain.value(),
        }
    }
}
