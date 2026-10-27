// Port of the app's processor DSP (src/renderer/src/core/processor/dynamics.ts, noise.ts and the
// EQ in processor.ts), so the plugin sounds exactly like Gritómetro Procesador de Audio. Keep both
// in sync: a change to the TS DSP needs the same change here. On top of the app (which is mono), the
// dynamics are linked across channels so a stereo track keeps its image.

use std::f64::consts::PI;

pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

pub fn lin_to_db(g: f32) -> f32 {
    if g > 1e-9 {
        20.0 * g.log10()
    } else {
        -180.0
    }
}

/// One-pole smoothing coefficient for a time constant in ms
pub fn coef(ms: f32, sample_rate: f32) -> f32 {
    1.0 - (-1.0 / (ms.max(0.01) / 1000.0 * sample_rate)).exp()
}

/// Values this small are set to 0: denormals make the CPU crawl after a few seconds of silence
pub const DENORMAL: f32 = 1e-25;

/// One-pole parameter glide (~20 ms), as in dynamics.ts. It starts at the first target, so a fresh
/// processor sounds exactly like the static settings, and snaps once it is close enough.
#[derive(Clone, Copy, Debug)]
pub struct Smoother {
    v: f32,
    k: f32,
    fresh: bool,
}

impl Smoother {
    pub fn new(sample_rate: f32) -> Self {
        Self { v: 0.0, k: coef(20.0, sample_rate), fresh: true }
    }

    #[inline]
    pub fn next(&mut self, target: f32) -> f32 {
        if self.fresh {
            self.fresh = false;
            self.v = target;
        } else if self.v != target {
            self.v += (target - self.v) * self.k;
            if (target - self.v).abs() < 1e-5 {
                self.v = target;
            }
        }
        self.v
    }

    /// Resting at `target` (a smoother that never ran starts there)
    pub fn settled(&mut self, target: f32) -> bool {
        if self.fresh {
            self.fresh = false;
            self.v = target;
        }
        self.v == target
    }
}

/// Static compressor curve with a quadratic soft knee, dB in → dB out
pub fn compressor_curve(in_db: f32, threshold_db: f32, ratio: f32, knee_db: f32) -> f32 {
    let over = in_db - threshold_db;
    if knee_db > 0.0 && over.abs() <= knee_db / 2.0 {
        return in_db + ((1.0 / ratio - 1.0) * (over + knee_db / 2.0).powi(2)) / (2.0 * knee_db);
    }
    if over <= 0.0 {
        in_db
    } else {
        threshold_db + over / ratio
    }
}

// ---- Second-order section for detector / sidechain filters (RBJ cookbook)

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FilterKind {
    Highpass,
    Lowpass,
    Bandpass,
}

#[derive(Clone, Copy, Debug)]
pub struct Section {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
    pub active: bool,
}

impl Default for Section {
    fn default() -> Self {
        Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: 0.0, z2: 0.0, active: false }
    }
}

impl Section {
    /// hz ≤ 0 switches the section off (pass-through)
    pub fn design(&mut self, kind: FilterKind, hz: f32, q: f32, sample_rate: f32) {
        self.active = hz > 0.0 && hz < sample_rate * 0.49;
        if !self.active {
            return;
        }
        let w = 2.0 * PI * hz as f64 / sample_rate as f64;
        let cos = w.cos();
        let alpha = w.sin() / (2.0 * q as f64);
        let a0 = 1.0 + alpha;
        let (b0, b1, b2) = match kind {
            FilterKind::Bandpass => (alpha / a0, 0.0, -alpha / a0),
            FilterKind::Lowpass => ((1.0 - cos) / 2.0 / a0, (1.0 - cos) / a0, (1.0 - cos) / 2.0 / a0),
            FilterKind::Highpass => ((1.0 + cos) / 2.0 / a0, -(1.0 + cos) / a0, (1.0 + cos) / 2.0 / a0),
        };
        self.b0 = b0 as f32;
        self.b1 = b1 as f32;
        self.b2 = b2 as f32;
        self.a1 = (-2.0 * cos / a0) as f32;
        self.a2 = ((1.0 - alpha) / a0) as f32;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        if !self.active {
            return x;
        }
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    /// Clears denormal state; call once per block
    pub fn flush(&mut self) {
        if self.z1.abs() < DENORMAL {
            self.z1 = 0.0;
        }
        if self.z2.abs() < DENORMAL {
            self.z2 = 0.0;
        }
    }
}

// ---- Gate / expander

/// Channels a linked processor handles (stereo); every channel gets the same gain
pub const MAX_CHANNELS: usize = 2;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum GateMode {
    Gate,
    Expander,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct GateSettings {
    pub on: bool,
    pub mode: GateMode,
    pub threshold_db: f32,
    pub hysteresis_db: f32,
    pub range_db: f32,
    pub ratio: f32,
    pub attack_ms: f32,
    pub hold_ms: f32,
    pub release_ms: f32,
    pub key_hpf_hz: f32,
    pub key_lpf_hz: f32,
}

/// Samples per channel in a block (all channels have the same length)
fn block_len(bufs: &[&mut [f32]]) -> usize {
    bufs.first().map_or(0, |b| b.len())
}

pub struct Gate {
    sample_rate: f32,
    env: f32,
    gain_db: f32,
    hold_left: f32,
    hpf: [Section; MAX_CHANNELS],
    lpf: [Section; MAX_CHANNELS],
    key: (f32, f32),
    amt: Smoother,
    pub open: bool,
    pub block_gain_db: f32,
}

impl Gate {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            env: 0.0,
            gain_db: 0.0,
            hold_left: 0.0,
            hpf: [Section::default(); MAX_CHANNELS],
            lpf: [Section::default(); MAX_CHANNELS],
            key: (-1.0, -1.0),
            amt: Smoother::new(sample_rate),
            open: true,
            block_gain_db: 0.0,
        }
    }

    /// Linked: the loudest channel opens the gate for all of them
    pub fn process(&mut self, bufs: &mut [&mut [f32]], p: &GateSettings) {
        if self.key != (p.key_hpf_hz, p.key_lpf_hz) {
            self.key = (p.key_hpf_hz, p.key_lpf_hz);
            for c in 0..MAX_CHANNELS {
                self.hpf[c].design(FilterKind::Highpass, p.key_hpf_hz, std::f32::consts::FRAC_1_SQRT_2, self.sample_rate);
                self.lpf[c].design(FilterKind::Lowpass, p.key_lpf_hz, std::f32::consts::FRAC_1_SQRT_2, self.sample_rate);
            }
        }
        let sr = self.sample_rate;
        let len = block_len(bufs);
        let chs = bufs.len().min(MAX_CHANNELS);
        // Peak envelope: instant rise, ~10 ms fall
        let env_decay = (-1.0 / (0.01 * sr)).exp();
        if !p.on && self.amt.settled(0.0) {
            for i in 0..len {
                let mut a = 0.0f32;
                for c in 0..chs {
                    a = a.max(self.lpf[c].process(self.hpf[c].process(bufs[c][i])).abs());
                }
                self.env = if a > self.env { a } else { self.env * env_decay };
            }
            self.open = true;
            self.gain_db = 0.0;
            self.block_gain_db = 0.0;
            self.flush();
            return;
        }
        let open_lin = db_to_lin(p.threshold_db);
        let close_lin = db_to_lin(p.threshold_db - p.hysteresis_db.max(0.0));
        let att = coef(p.attack_ms, sr);
        let rel = coef(p.release_ms, sr);
        let hold = p.hold_ms / 1000.0 * sr;
        let range = p.range_db.min(0.0);
        let mut lowest = 0.0f32;
        for i in 0..len {
            let mut a = 0.0f32;
            for c in 0..chs {
                a = a.max(self.lpf[c].process(self.hpf[c].process(bufs[c][i])).abs());
            }
            self.env = if a > self.env { a } else { self.env * env_decay };
            let target;
            if p.mode == GateMode::Expander {
                let env_db = lin_to_db(self.env);
                if env_db >= p.threshold_db {
                    self.open = true;
                    self.hold_left = hold;
                    target = 0.0;
                } else if self.hold_left > 0.0 {
                    self.hold_left -= 1.0;
                    target = 0.0;
                } else {
                    self.open = false;
                    target = range.max((env_db - p.threshold_db) * (p.ratio.max(1.0) - 1.0));
                }
            } else {
                if self.env >= open_lin || (self.open && self.env >= close_lin) {
                    self.open = true;
                    self.hold_left = hold;
                } else if self.hold_left > 0.0 {
                    self.hold_left -= 1.0;
                } else {
                    self.open = false;
                }
                target = if self.open { 0.0 } else { range };
            }
            self.gain_db += (target - self.gain_db) * if target > self.gain_db { att } else { rel };
            // Switching the gate on/off fades its action in/out instead of jumping
            let g = self.gain_db * self.amt.next(if p.on { 1.0 } else { 0.0 });
            lowest = lowest.min(g);
            let lin = db_to_lin(g);
            for c in 0..chs {
                bufs[c][i] *= lin;
            }
        }
        self.block_gain_db = lowest;
        self.flush();
    }

    fn flush(&mut self) {
        self.hpf.iter_mut().chain(self.lpf.iter_mut()).for_each(Section::flush);
        if self.env < DENORMAL {
            self.env = 0.0;
        }
    }
}

// ---- Compressor

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Detector {
    Peak,
    Rms,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CompSettings {
    pub on: bool,
    pub threshold_db: f32,
    pub ratio: f32,
    pub knee_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    pub auto_makeup: bool,
    /// Parallel compression, 0…100 %
    pub mix: f32,
    pub detector: Detector,
    pub sc_hpf_hz: f32,
}

/// Makeup added by `auto_makeup`: the gain the static curve takes away at −18 dBFS
pub fn auto_makeup_db(threshold_db: f32, ratio: f32, knee_db: f32) -> f32 {
    let r = -18.0;
    (r - compressor_curve(r, threshold_db, ratio.max(1.0), knee_db.max(0.0))).max(0.0)
}

pub struct Compressor {
    sample_rate: f32,
    gr_db: f32,
    ms: f32,
    sc: [Section; MAX_CHANNELS],
    sc_hz: f32,
    amt: Smoother,
    makeup_sm: Smoother,
    wet_sm: Smoother,
    pub block_gr: f32,
}

impl Compressor {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            gr_db: 0.0,
            ms: 0.0,
            sc: [Section::default(); MAX_CHANNELS],
            sc_hz: -1.0,
            amt: Smoother::new(sample_rate),
            makeup_sm: Smoother::new(sample_rate),
            wet_sm: Smoother::new(sample_rate),
            block_gr: 0.0,
        }
    }

    /// Linked: the detector follows the loudest channel, every channel gets the same gain
    pub fn process(&mut self, bufs: &mut [&mut [f32]], p: &CompSettings) {
        if p.sc_hpf_hz != self.sc_hz {
            self.sc_hz = p.sc_hpf_hz;
            for s in self.sc.iter_mut() {
                s.design(FilterKind::Highpass, p.sc_hpf_hz, std::f32::consts::FRAC_1_SQRT_2, self.sample_rate);
            }
        }
        let len = block_len(bufs);
        let chs = bufs.len().min(MAX_CHANNELS);
        let att = coef(p.attack_ms, self.sample_rate);
        let rel = coef(p.release_ms, self.sample_rate);
        let rms_k = coef(10.0, self.sample_rate);
        let ratio = p.ratio.max(1.0);
        let knee = p.knee_db.max(0.0);
        let wet = p.mix.clamp(0.0, 100.0) / 100.0;
        let makeup = db_to_lin(p.makeup_db + if p.auto_makeup { auto_makeup_db(p.threshold_db, p.ratio, p.knee_db) } else { 0.0 });
        // Fully off (and done fading out): only the detector runs
        let off = !p.on && self.amt.settled(0.0);
        let mut lowest = 0.0f32;
        for i in 0..len {
            let mut peak = 0.0f32;
            for c in 0..chs {
                peak = peak.max(self.sc[c].process(bufs[c][i]).abs());
            }
            let level_db = if p.detector == Detector::Rms {
                self.ms += (peak * peak - self.ms) * rms_k;
                // +3 dB so a sine reads its peak level, like the peak detector
                lin_to_db(self.ms.sqrt()) + 3.01
            } else {
                lin_to_db(peak)
            };
            if off {
                continue;
            }
            let target = compressor_curve(level_db, p.threshold_db, ratio, knee) - level_db;
            // More reduction = attack, less = release
            self.gr_db += (target - self.gr_db) * if target < self.gr_db { att } else { rel };
            lowest = lowest.min(self.gr_db);
            let g = db_to_lin(self.gr_db) * self.makeup_sm.next(makeup);
            let w = self.wet_sm.next(wet) * self.amt.next(if p.on { 1.0 } else { 0.0 });
            for c in 0..chs {
                let x = bufs[c][i];
                bufs[c][i] = x + (x * g - x) * w;
            }
        }
        if off {
            self.gr_db = 0.0;
        }
        self.block_gr = if p.on { lowest } else { 0.0 };
        self.sc.iter_mut().for_each(Section::flush);
        if self.ms < DENORMAL {
            self.ms = 0.0;
        }
    }
}

// ---- De-esser

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum DeEssMode {
    Split,
    Wide,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct DeEsserSettings {
    pub on: bool,
    pub freq: f32,
    pub q: f32,
    pub threshold_db: f32,
    pub ratio: f32,
    pub range_db: f32,
    pub mode: DeEssMode,
    pub listen: bool,
}

pub struct DeEsser {
    sample_rate: f32,
    bp: [Section; MAX_CHANNELS],
    lp: [Section; MAX_CHANNELS],
    env: f32,
    gr_db: f32,
    key: (f32, f32),
    amt: Smoother,
    pub block_gr: f32,
}

impl DeEsser {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            bp: [Section::default(); MAX_CHANNELS],
            lp: [Section::default(); MAX_CHANNELS],
            env: 0.0,
            gr_db: 0.0,
            key: (-1.0, -1.0),
            amt: Smoother::new(sample_rate),
            block_gr: 0.0,
        }
    }

    /// Linked: sibilance on either side turns both down
    pub fn process(&mut self, bufs: &mut [&mut [f32]], p: &DeEsserSettings) {
        if self.key != (p.freq, p.q) {
            self.key = (p.freq, p.q);
            let f = p.freq.min(self.sample_rate * 0.45).max(1000.0);
            for c in 0..MAX_CHANNELS {
                self.bp[c].design(FilterKind::Bandpass, f, p.q.max(0.3), self.sample_rate);
                // Split: low = LP(x), high = x − low, so the bands always add back up exactly
                self.lp[c].design(FilterKind::Lowpass, f * 0.6, std::f32::consts::FRAC_1_SQRT_2, self.sample_rate);
            }
        }
        if !p.on && self.amt.settled(0.0) {
            self.gr_db = 0.0;
            self.block_gr = 0.0;
            return;
        }
        let len = block_len(bufs);
        let chs = bufs.len().min(MAX_CHANNELS);
        let att = coef(0.5, self.sample_rate);
        let rel = coef(60.0, self.sample_rate);
        let env_decay = (-1.0 / (0.02 * self.sample_rate)).exp();
        let range = p.range_db.min(0.0);
        let slope = 1.0 - 1.0 / p.ratio.max(1.0);
        let mut lowest = 0.0f32;
        let mut band = [0.0f32; MAX_CHANNELS];
        for i in 0..len {
            let mut a = 0.0f32;
            for c in 0..chs {
                band[c] = self.bp[c].process(bufs[c][i]);
                a = a.max(band[c].abs());
            }
            self.env = if a > self.env { a } else { self.env * env_decay };
            let over = lin_to_db(self.env) - p.threshold_db;
            let target = if over > 0.0 { range.max(-over * slope) } else { 0.0 };
            self.gr_db += (target - self.gr_db) * if target < self.gr_db { att } else { rel };
            let g_db = self.gr_db * self.amt.next(if p.on { 1.0 } else { 0.0 });
            lowest = lowest.min(g_db);
            let g = db_to_lin(g_db);
            for c in 0..chs {
                let x = bufs[c][i];
                let low = self.lp[c].process(x);
                bufs[c][i] = if p.listen {
                    band[c]
                } else if p.mode == DeEssMode::Wide {
                    x * g
                } else {
                    low + (x - low) * g
                };
            }
        }
        self.block_gr = lowest;
        self.bp.iter_mut().chain(self.lp.iter_mut()).for_each(Section::flush);
        if self.env < DENORMAL {
            self.env = 0.0;
        }
    }
}

// ---- Saturation

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SatMode {
    Tube,
    Tape,
    Amp,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct SatSettings {
    pub on: bool,
    pub mode: SatMode,
    pub drive_db: f32,
    pub tone_hz: f32,
    pub mix: f32,
}

const TUBE_BIAS: f64 = 0.25;

/// Static saturation curve, unity gain for small signals
pub fn saturate(x: f64, drive: f64, mode: SatMode) -> f64 {
    let u = x * drive;
    match mode {
        SatMode::Amp => amp_clip(u) / drive.sqrt(),
        SatMode::Tube => {
            let slope = 1.0 - TUBE_BIAS.tanh().powi(2);
            ((u + TUBE_BIAS).tanh() - TUBE_BIAS.tanh()) / slope / drive
        }
        SatMode::Tape => u.tanh() / drive,
    }
}

fn amp_clip(u: f64) -> f64 {
    let lim = if u >= 0.0 { 1.0 } else { 0.7 };
    let v = u / lim;
    lim * v / (1.0 + v.abs().powi(4)).powf(0.25)
}

/// The curve runs at this many times the sample rate, so its harmonics don't fold back (aliasing)
const SAT_OS: usize = 4;
const SAT_TAPS: usize = 129;
/// Delay of the oversampling filters (up + down), samples; the dry path waits as long
pub const SAT_LATENCY: usize = (SAT_TAPS - 1) / SAT_OS;
const SAT_PHASE_TAPS: usize = SAT_TAPS.div_ceil(SAT_OS);
const SAT_IN_MASK: usize = 63;
const SAT_OS_MASK: usize = 255;

fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term) = (1.0, 1.0);
    for k in 1..50 {
        term *= (x / (2.0 * k as f64)).powi(2);
        sum += term;
        if term < 1e-12 * sum {
            break;
        }
    }
    sum
}

/// Linear-phase low-pass at the oversampled rate (Kaiser-windowed sinc, cut at 0.45 × the base rate), unity DC gain
fn sat_fir() -> [f64; SAT_TAPS] {
    let mut h = [0.0; SAT_TAPS];
    let mid = (SAT_TAPS - 1) as f64 / 2.0;
    let fc = 0.45 / SAT_OS as f64;
    let beta = 8.0;
    let mut sum = 0.0;
    for (i, v) in h.iter_mut().enumerate() {
        let t = i as f64 - mid;
        let sinc = if t == 0.0 { 2.0 * fc } else { (2.0 * PI * fc * t).sin() / (PI * t) };
        *v = sinc * bessel_i0(beta * (1.0 - (t / mid).powi(2)).sqrt()) / bessel_i0(beta);
        sum += *v;
    }
    h.iter_mut().for_each(|v| *v /= sum);
    h
}

pub struct Saturator {
    sample_rate: f32,
    tone: Section,
    tone_hz: f32,
    dc: f64,
    dc_in: f64,
    amt: Smoother,
    drive_sm: Smoother,
    wet_sm: Smoother,
    fir: [f64; SAT_TAPS],
    /// Interpolator phases: output k = SAT_OS · Σ h[k + SAT_OS·m] · x[t − m]
    phases: [[f64; SAT_PHASE_TAPS]; SAT_OS],
    /// Dry path, delayed like the oversampled one
    dry: [f32; SAT_LATENCY],
    dry_pos: usize,
    xh: [f64; SAT_IN_MASK + 1],
    x_pos: usize,
    os: [f64; SAT_OS_MASK + 1],
    os_pos: usize,
}

impl Saturator {
    pub fn new(sample_rate: f32) -> Self {
        let fir = sat_fir();
        let mut phases = [[0.0; SAT_PHASE_TAPS]; SAT_OS];
        for (k, ph) in phases.iter_mut().enumerate() {
            for (m, v) in ph.iter_mut().enumerate() {
                let i = k + SAT_OS * m;
                *v = if i < SAT_TAPS { fir[i] * SAT_OS as f64 } else { 0.0 };
            }
        }
        Self {
            sample_rate,
            tone: Section::default(),
            tone_hz: -1.0,
            dc: 0.0,
            dc_in: 0.0,
            amt: Smoother::new(sample_rate),
            drive_sm: Smoother::new(sample_rate),
            wet_sm: Smoother::new(sample_rate),
            fir,
            phases,
            dry: [0.0; SAT_LATENCY],
            dry_pos: 0,
            xh: [0.0; SAT_IN_MASK + 1],
            x_pos: 0,
            os: [0.0; SAT_OS_MASK + 1],
            os_pos: 0,
        }
    }

    pub fn process(&mut self, buf: &mut [f32], p: &SatSettings) {
        if p.tone_hz != self.tone_hz {
            self.tone_hz = p.tone_hz;
            let hz = if p.tone_hz >= 19000.0 { 0.0 } else { p.tone_hz };
            self.tone.design(FilterKind::Lowpass, hz, std::f32::consts::FRAC_1_SQRT_2, self.sample_rate);
        }
        // The delay always runs, so latency doesn't change when the saturator is switched
        let off = !p.on && self.amt.settled(0.0);
        let drive = db_to_lin(p.drive_db.max(0.0));
        let wet = p.mix.clamp(0.0, 100.0) / 100.0;
        // DC blocker after the asymmetric curve (~5 Hz)
        let r = 1.0 - (2.0 * PI * 5.0) / self.sample_rate as f64;
        for s in buf.iter_mut() {
            let x = *s;
            let d = self.dry[self.dry_pos];
            self.dry[self.dry_pos] = x;
            self.dry_pos = (self.dry_pos + 1) % SAT_LATENCY;
            self.xh[self.x_pos] = x as f64;
            if off {
                self.x_pos = (self.x_pos + 1) & SAT_IN_MASK;
                *s = d;
                continue;
            }
            // Up 4×, saturate, back down: the harmonics above the base Nyquist are filtered out
            let dr = self.drive_sm.next(drive) as f64;
            for (k, ph) in self.phases.iter().enumerate() {
                let mut acc = 0.0;
                for (m, c) in ph.iter().enumerate() {
                    acc += c * self.xh[self.x_pos.wrapping_sub(m) & SAT_IN_MASK];
                }
                self.os[(self.os_pos + k) & SAT_OS_MASK] = saturate(acc, dr, p.mode);
            }
            // Symmetric filter: pair the taps that share a coefficient
            let half = (SAT_TAPS - 1) / 2;
            let mut sat = self.fir[half] * self.os[self.os_pos.wrapping_sub(half) & SAT_OS_MASK];
            for j in 0..half {
                sat += self.fir[j] * (self.os[self.os_pos.wrapping_sub(j) & SAT_OS_MASK] + self.os[self.os_pos.wrapping_sub(SAT_TAPS - 1 - j) & SAT_OS_MASK]);
            }
            self.os_pos = (self.os_pos + SAT_OS) & SAT_OS_MASK;
            self.x_pos = (self.x_pos + 1) & SAT_IN_MASK;
            let y = sat - self.dc_in + r * self.dc;
            self.dc_in = sat;
            self.dc = y;
            let t = self.tone.process(y as f32);
            let w = self.wet_sm.next(wet) * self.amt.next(if p.on { 1.0 } else { 0.0 });
            *s = d + (t - d) * w;
        }
        self.tone.flush();
        if self.dc.abs() < DENORMAL as f64 {
            self.dc = 0.0;
        }
        if self.dc_in.abs() < DENORMAL as f64 {
            self.dc_in = 0.0;
        }
    }
}

// ---- Look-ahead true-peak limiter

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct LimiterSettings {
    pub on: bool,
    /// True-peak ceiling: inter-sample peaks stay below it
    pub ceiling_db: f32,
    pub release_ms: f32,
}

pub const LOOKAHEAD_MS: f32 = 1.5;

pub fn lookahead_samples(sample_rate: f32) -> usize {
    ((LOOKAHEAD_MS / 1000.0 * sample_rate).round() as usize).max(1)
}

/// The true-peak interpolator reports a peak this many samples after it entered
const TP_DELAY: usize = 5;
/// Oversampling of the true-peak detector (ITU-R BS.1770 annex 2), as the app's meter
const TP_OS: usize = 4;
const TP_TAPS: usize = 12;

/// Total delay of the limiter (look-ahead + true-peak detection)
pub fn limiter_latency(sample_rate: f32) -> usize {
    lookahead_samples(sample_rate) + TP_DELAY
}

/// Same windowed-sinc phases as TruePeakMeter in core/studio/dsp.ts (unity DC gain each)
fn tp_phases() -> [[f64; TP_TAPS]; TP_OS] {
    let n = TP_OS * TP_TAPS;
    let mid = (n - 1) as f64 / 2.0;
    let h: Vec<f64> = (0..n)
        .map(|i| {
            let t = (i as f64 - mid) / TP_OS as f64;
            let sinc = if t == 0.0 { 1.0 } else { (PI * t).sin() / (PI * t) };
            sinc * (0.5 - 0.5 * (2.0 * PI * (i as f64 + 0.5) / n as f64).cos())
        })
        .collect();
    let mut out = [[0.0; TP_TAPS]; TP_OS];
    for (k, ph) in out.iter_mut().enumerate() {
        for (m, v) in ph.iter_mut().enumerate() {
            *v = h[k + TP_OS * m];
        }
        let sum: f64 = ph.iter().sum();
        ph.iter_mut().for_each(|v| *v /= sum);
    }
    out
}

pub struct Limiter {
    sample_rate: f32,
    pub latency: usize,
    /// Look-ahead window, samples
    w: usize,
    delay: [Vec<f32>; MAX_CHANNELS],
    pos: usize,
    phases: [[f64; TP_TAPS]; TP_OS],
    /// Input history per channel for the true-peak interpolator, stored twice to read it without modulo
    hist: [[f64; TP_TAPS * 2]; MAX_CHANNELS],
    h_pos: usize,
    /// Gain needed now: instant attack, release back towards 1
    env: f64,
    /// Minimum of env over the last w + 1 samples: monotonic queue of (value, step), oldest first
    q_val: Vec<f64>,
    q_step: Vec<u64>,
    q_head: usize,
    q_len: usize,
    step: u64,
    /// Last w held minima (moving average)
    avg: Vec<f64>,
    avg_pos: usize,
    sum: f64,
    amt: Smoother,
    pub block_gr: f32,
}

impl Limiter {
    pub fn new(sample_rate: f32) -> Self {
        let w = lookahead_samples(sample_rate);
        let latency = w + TP_DELAY;
        Self {
            sample_rate,
            latency,
            w,
            delay: [vec![0.0; latency], vec![0.0; latency]],
            pos: 0,
            phases: tp_phases(),
            hist: [[0.0; TP_TAPS * 2]; MAX_CHANNELS],
            h_pos: 0,
            env: 1.0,
            q_val: vec![0.0; w + 2],
            q_step: vec![0; w + 2],
            q_head: 0,
            q_len: 0,
            step: 0,
            avg: vec![1.0; w],
            avg_pos: 0,
            sum: w as f64,
            amt: Smoother::new(sample_rate),
            block_gr: 0.0,
        }
    }

    /// Linked: the channel that needs the most reduction sets it for all
    pub fn process(&mut self, bufs: &mut [&mut [f32]], p: &LimiterSettings) {
        let len = block_len(bufs);
        let chs = bufs.len().min(MAX_CHANNELS);
        let w = self.w;
        let ceil = db_to_lin(p.ceiling_db.min(0.0)) as f64;
        let rel = coef(p.release_ms, self.sample_rate) as f64;
        let mut lowest = 1.0f64;
        let mut out = [0.0f32; MAX_CHANNELS];
        for i in 0..len {
            let newest = self.h_pos + TP_TAPS;
            let mut peak = 0.0f64;
            for c in 0..chs {
                let x = bufs[c][i];
                // The delay always runs, so latency doesn't change when the limiter is switched
                out[c] = self.delay[c][self.pos];
                self.delay[c][self.pos] = x;
                // True peak between the samples that entered 6 and 5 steps ago (4× interpolation, BS.1770)
                let h = &mut self.hist[c];
                h[self.h_pos] = x as f64;
                h[newest] = x as f64;
                peak = peak.max(h[newest - 6].abs());
                for ph in self.phases.iter() {
                    let mut acc = 0.0;
                    for (m, v) in ph.iter().enumerate() {
                        acc += v * h[newest - m];
                    }
                    peak = peak.max(acc.abs());
                }
            }
            self.pos = (self.pos + 1) % self.latency;
            self.h_pos = (self.h_pos + 1) % TP_TAPS;
            let need = if peak > ceil { ceil / peak } else { 1.0 };
            let released = self.env + (1.0 - self.env) * rel;
            self.env = need.min(released);
            // Hold the lowest gain over the window, then average it over the window: the gain glides
            // down (no step, no distortion) and is fully down exactly when the peak comes out
            let m = self.hold_min(self.env, w as u64 + 1);
            self.sum += m - self.avg[self.avg_pos];
            self.avg[self.avg_pos] = m;
            self.avg_pos = (self.avg_pos + 1) % w;
            let g = self.sum / w as f64;
            let k = (1.0 + (g - 1.0) * self.amt.next(if p.on { 1.0 } else { 0.0 }) as f64) as f32;
            let c32 = ceil as f32;
            for c in 0..chs {
                let mut y = out[c] * k;
                if p.on {
                    // Safety net for rounding: never engages on a signal the gain already handled
                    y = y.clamp(-c32, c32);
                }
                bufs[c][i] = y;
            }
            if p.on {
                lowest = lowest.min(g);
            }
        }
        // Re-add the window so the running sum never drifts
        self.sum = self.avg.iter().sum();
        self.block_gr = if p.on { lin_to_db(lowest as f32) } else { 0.0 };
    }

    /// Pushes v and returns the minimum of the last `span` values (≥ 1 when fewer were pushed)
    fn hold_min(&mut self, v: f64, span: u64) -> f64 {
        let cap = self.q_val.len();
        // Values at the back that are not lower than v can never be the minimum again
        while self.q_len > 0 && self.q_val[(self.q_head + self.q_len - 1) % cap] >= v {
            self.q_len -= 1;
        }
        let at = (self.q_head + self.q_len) % cap;
        self.q_val[at] = v;
        self.q_step[at] = self.step;
        self.q_len += 1;
        if self.q_step[self.q_head] + span <= self.step {
            self.q_head = (self.q_head + 1) % cap;
            self.q_len -= 1;
        }
        self.step += 1;
        self.q_val[self.q_head].min(1.0)
    }
}

// ---- Spectral noise reduction (STFT, Wiener gain, decision-directed a-priori SNR)

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum NoiseMode {
    Adaptive,
    Learned,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct NoiseSettings {
    pub on: bool,
    pub mode: NoiseMode,
    pub reduction_db: f32,
    pub sensitivity_db: f32,
    pub smoothing: f32,
    pub from_hz: f32,
    pub listen_removed: bool,
}

/// FFT size of the suppressor: fixed in the plugin so the latency never changes
pub const NOISE_FFT: usize = 1024;

/// In-place radix-2 FFT (same as core/studio/distortion.ts)
pub fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0;
        while i < n {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for k in 0..len / 2 {
                let a = i + k;
                let b = a + len / 2;
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// Linearly resamples a per-bin profile to `bins` bins
pub fn resample_profile(profile: &[f32], bins: usize) -> Vec<f64> {
    let mut out = vec![0.0; bins];
    let n = profile.len();
    if n == 0 {
        return out;
    }
    for (k, o) in out.iter_mut().enumerate() {
        let x = k as f64 / (bins.max(2) - 1) as f64 * (n - 1) as f64;
        let i = x.floor() as usize;
        let f = x - i as f64;
        *o = profile[i] as f64 * (1.0 - f) + profile[(i + 1).min(n - 1)] as f64 * f;
    }
    out
}

pub struct NoiseSuppressor {
    sample_rate: f32,
    n: usize,
    hop: usize,
    bins: usize,
    win: Vec<f64>,
    in_buf: Vec<f64>,
    out_buf: Vec<f64>,
    fill: usize,
    out_pos: usize,
    re: Vec<f64>,
    im: Vec<f64>,
    smooth: Vec<f64>,
    tracked: Vec<f64>,
    /// Learned profile (bins); valid when has_learned
    learned: Vec<f64>,
    has_learned: bool,
    prev_clean: Vec<f64>,
    gains: Vec<f64>,
    power: Vec<f64>,
    learn_left: usize,
    learn_sum: Vec<f64>,
    learn_frames: usize,
    frames: usize,
    pub reduction_db: f32,
    /// Filled when a learning run finishes (preallocated: nothing allocates on the audio thread)
    learned_out: Vec<f32>,
    learned_ready: bool,
}

impl NoiseSuppressor {
    pub fn new(sample_rate: f32) -> Self {
        let n = NOISE_FFT;
        let bins = n / 2 + 1;
        let win = (0..n).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos()).collect();
        Self {
            sample_rate,
            n,
            hop: n / 4,
            bins,
            win,
            in_buf: vec![0.0; n],
            out_buf: vec![0.0; n * 2],
            fill: 0,
            out_pos: 0,
            re: vec![0.0; n],
            im: vec![0.0; n],
            smooth: vec![0.0; bins],
            tracked: vec![0.0; bins],
            learned: vec![0.0; bins],
            has_learned: false,
            prev_clean: vec![0.0; bins],
            gains: vec![1.0; bins],
            power: vec![0.0; bins],
            learn_left: 0,
            learn_sum: vec![0.0; bins],
            learn_frames: 0,
            frames: 0,
            reduction_db: 0.0,
            learned_out: vec![0.0; bins],
            learned_ready: false,
        }
    }

    pub fn latency(&self) -> usize {
        self.n
    }

    pub fn bins(&self) -> usize {
        self.bins
    }

    pub fn set_profile(&mut self, profile: Option<Vec<f64>>) {
        match profile {
            Some(p) if p.len() == self.bins => {
                self.learned.copy_from_slice(&p);
                self.has_learned = true;
            }
            _ => self.has_learned = false,
        }
    }

    pub fn has_profile(&self) -> bool {
        self.has_learned
    }

    /// The profile of a finished learning run, once (allocates: call it inside permit_alloc)
    pub fn take_learned(&mut self) -> Option<Vec<f32>> {
        if !self.learned_ready {
            return None;
        }
        self.learned_ready = false;
        Some(self.learned_out.clone())
    }

    /// Starts capturing the noise profile for `seconds` (stay silent meanwhile)
    pub fn learn(&mut self, seconds: f32) {
        self.learn_left = ((seconds * self.sample_rate / self.hop as f32).round() as usize).max(1);
        self.learn_sum.iter_mut().for_each(|v| *v = 0.0);
        self.learn_frames = 0;
    }

    pub fn learning(&self) -> bool {
        self.learn_left > 0
    }

    pub fn process(&mut self, buf: &mut [f32], p: &NoiseSettings) {
        let (n, h) = (self.n, self.hop);
        for s in buf.iter_mut() {
            self.in_buf[self.fill] = *s as f64;
            *s = self.out_buf[self.out_pos] as f32;
            self.out_buf[self.out_pos] = 0.0;
            self.out_pos += 1;
            self.fill += 1;
            if self.fill == n {
                self.frame(p);
                // Slide the input by one hop
                self.in_buf.copy_within(h.., 0);
                self.fill = n - h;
            }
            if self.out_pos == h {
                // Slide the output: the next hop to read moves to the front
                let len = self.out_buf.len();
                self.out_buf.copy_within(h.., 0);
                self.out_buf[len - h..].iter_mut().for_each(|v| *v = 0.0);
                self.out_pos = 0;
            }
        }
    }

    fn frame(&mut self, p: &NoiseSettings) {
        let n = self.n;
        let bins = self.bins;
        for i in 0..n {
            self.re[i] = self.in_buf[i] * self.win[i];
            self.im[i] = 0.0;
        }
        fft(&mut self.re, &mut self.im);
        self.frames += 1;
        // Minimum-statistics tracker: follows the floor, rises ~3 dB/s when the floor rises
        let rise = 10f64.powf(3.0 * self.hop as f64 / self.sample_rate as f64 / 10.0);
        for k in 0..bins {
            let pw = self.re[k] * self.re[k] + self.im[k] * self.im[k];
            self.power[k] = pw;
            self.smooth[k] = if self.frames == 1 { pw } else { self.smooth[k] * 0.85 + pw * 0.15 };
            let t = self.tracked[k];
            self.tracked[k] = if self.frames == 1 || self.smooth[k] < t { self.smooth[k] } else { t * rise };
        }
        if self.learn_left > 0 {
            for k in 0..bins {
                self.learn_sum[k] += self.power[k];
            }
            self.learn_frames += 1;
            self.learn_left -= 1;
            if self.learn_left == 0 {
                let frames = self.learn_frames as f64;
                for k in 0..bins {
                    self.learned[k] = self.learn_sum[k] / frames;
                    self.learned_out[k] = self.learned[k] as f32;
                }
                self.has_learned = true;
                self.learned_ready = true;
            }
        }

        let floor = 10f64.powf(p.reduction_db.min(0.0) as f64 / 20.0);
        let over = 10f64.powf(p.sensitivity_db as f64 / 10.0);
        // Decision-directed weight: 0.9 (responsive) … 0.995 (very smooth)
        let alpha = 0.9 + (p.smoothing.clamp(0.0, 100.0) as f64 / 100.0) * 0.095;
        let from_bin = ((p.from_hz.max(0.0) / self.sample_rate) * n as f32).floor() as usize;
        let use_learned = p.mode == NoiseMode::Learned && self.has_learned;
        for k in 0..bins {
            // The tracked minimum sits below the mean noise power: ×2 compensates its bias
            let base = if use_learned { self.learned[k] } else { self.tracked[k] * 2.0 };
            let nz = base * over + 1e-20;
            let mut g = 1.0;
            if p.on && k >= from_bin {
                let post = self.power[k] / nz;
                let prio = alpha * (self.prev_clean[k] / nz) + (1.0 - alpha) * (post - 1.0).max(0.0);
                g = floor.max(prio / (1.0 + prio));
            }
            self.gains[k] = g;
        }
        // Light smoothing across frequency against isolated "chirps"
        let mut prev = self.gains[0];
        for k in 1..bins - 1 {
            let cur = self.gains[k];
            self.gains[k] = floor.max((prev + 2.0 * cur + self.gains[k + 1]) / 4.0);
            prev = cur;
        }
        let (mut in_sum, mut out_sum) = (0.0, 0.0);
        for k in 0..bins {
            let g = self.gains[k];
            self.prev_clean[k] = g * g * self.power[k];
            in_sum += self.power[k];
            out_sum += g * g * self.power[k];
            // Mirror onto the negative frequencies so the inverse FFT stays real
            let m = if p.on && p.listen_removed { 1.0 - g } else { g };
            self.re[k] *= m;
            self.im[k] *= m;
            if k > 0 && k < n / 2 {
                self.re[n - k] *= m;
                self.im[n - k] *= m;
            }
        }
        self.reduction_db = if in_sum > 1e-12 { (10.0 * (out_sum / in_sum).log10()).min(0.0) as f32 } else { 0.0 };
        // Inverse FFT via conjugation
        for v in self.im.iter_mut() {
            *v = -*v;
        }
        fft(&mut self.re, &mut self.im);
        // Hann analysis × Hann synthesis at 75 % overlap sums to 1.5
        let scale = 1.0 / (n as f64 * 1.5);
        let base = self.out_pos;
        for i in 0..n {
            self.out_buf[base + i] += self.re[i] * self.win[i] * scale;
        }
    }
}

// ---- Parametric EQ: the exact filters Web Audio's BiquadFilterNode uses

pub const MAX_BANDS: usize = 8;
pub const STAGES_PER_BAND: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BandType {
    Peaking,
    LowShelf,
    HighShelf,
    Highpass,
    Lowpass,
    Notch,
    Bandpass,
}

impl BandType {
    pub fn has_gain(self) -> bool {
        matches!(self, BandType::Peaking | BandType::LowShelf | BandType::HighShelf)
    }
    pub fn has_q(self) -> bool {
        !matches!(self, BandType::LowShelf | BandType::HighShelf)
    }
    pub fn has_slope(self) -> bool {
        matches!(self, BandType::Highpass | BandType::Lowpass)
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct BandSettings {
    pub on: bool,
    pub kind: BandType,
    pub freq: f32,
    pub gain_db: f32,
    pub q: f32,
    /// dB per octave for high/low-pass: 12, 24, 36 or 48
    pub slope: u32,
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Coefs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

const IDENTITY: Coefs = Coefs { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };

/// Biquad coefficients exactly as the Web Audio spec computes them (Q for high/low-pass in dB)
fn node_biquad(kind: BandType, freq: f64, q: f64, gain: f64, sr: f64) -> Coefs {
    let w = 2.0 * PI * freq / sr;
    let (sin, cos) = (w.sin(), w.cos());
    let a = 10f64.powf(gain / 40.0);
    let (b0, b1, b2, a0, a1, a2);
    match kind {
        BandType::Lowpass | BandType::Highpass => {
            let alpha = sin / (2.0 * 10f64.powf(q / 20.0));
            let lp = kind == BandType::Lowpass;
            b0 = if lp { (1.0 - cos) / 2.0 } else { (1.0 + cos) / 2.0 };
            b1 = if lp { 1.0 - cos } else { -(1.0 + cos) };
            b2 = b0;
            a0 = 1.0 + alpha;
            a1 = -2.0 * cos;
            a2 = 1.0 - alpha;
        }
        BandType::Bandpass | BandType::Notch => {
            let alpha = sin / (2.0 * q);
            if kind == BandType::Bandpass {
                b0 = alpha;
                b1 = 0.0;
                b2 = -alpha;
            } else {
                b0 = 1.0;
                b1 = -2.0 * cos;
                b2 = 1.0;
            }
            a0 = 1.0 + alpha;
            a1 = -2.0 * cos;
            a2 = 1.0 - alpha;
        }
        BandType::LowShelf | BandType::HighShelf => {
            // Web Audio shelves use a fixed slope S = 1
            let alpha = sin / 2.0 * std::f64::consts::SQRT_2;
            let k = 2.0 * a.sqrt() * alpha;
            if kind == BandType::LowShelf {
                b0 = a * (a + 1.0 - (a - 1.0) * cos + k);
                b1 = 2.0 * a * (a - 1.0 - (a + 1.0) * cos);
                b2 = a * (a + 1.0 - (a - 1.0) * cos - k);
                a0 = a + 1.0 + (a - 1.0) * cos + k;
                a1 = -2.0 * (a - 1.0 + (a + 1.0) * cos);
                a2 = a + 1.0 + (a - 1.0) * cos - k;
            } else {
                b0 = a * (a + 1.0 + (a - 1.0) * cos + k);
                b1 = -2.0 * a * (a - 1.0 + (a + 1.0) * cos);
                b2 = a * (a + 1.0 + (a - 1.0) * cos - k);
                a0 = a + 1.0 - (a - 1.0) * cos + k;
                a1 = 2.0 * (a - 1.0 - (a + 1.0) * cos);
                a2 = a + 1.0 - (a - 1.0) * cos - k;
            }
        }
        BandType::Peaking => {
            let alpha = sin / (2.0 * q);
            b0 = 1.0 + alpha * a;
            b1 = -2.0 * cos;
            b2 = 1.0 - alpha * a;
            a0 = 1.0 + alpha / a;
            a1 = -2.0 * cos;
            a2 = 1.0 - alpha / a;
        }
    }
    Coefs { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/// The sections (always STAGES_PER_BAND, unused ones are identity) that realise a band
pub fn band_stages(b: &BandSettings, eq_on: bool, sr: f32) -> [Coefs; STAGES_PER_BAND] {
    let mut out = [IDENTITY; STAGES_PER_BAND];
    if !(eq_on && b.on) {
        return out;
    }
    let freq = (b.freq as f64).clamp(10.0, sr as f64 * 0.49);
    if b.kind.has_slope() {
        let sections = (b.slope / 12).clamp(1, 4) as usize;
        let order = (sections * 2) as f64;
        let mut qs: Vec<f64> = (0..sections).map(|k| 1.0 / (2.0 * (PI * (2 * k + 1) as f64 / (2.0 * order)).cos())).collect();
        // The band's Q shapes the last (sharpest) section: 0.71 = flat Butterworth
        let last = qs.len() - 1;
        qs[last] *= b.q as f64 / std::f64::consts::FRAC_1_SQRT_2;
        for (i, q) in qs.iter().enumerate() {
            out[i] = node_biquad(b.kind, freq, 20.0 * q.log10(), 0.0, sr as f64);
        }
    } else {
        let gain = if b.kind.has_gain() { b.gain_db as f64 } else { 0.0 };
        out[0] = node_biquad(b.kind, freq, b.q as f64, gain, sr as f64);
    }
    out
}

/// Magnitude response in dB of a set of sections at `f` Hz
pub fn response_db(sections: &[Coefs], f: f64, sr: f64) -> f64 {
    let w = 2.0 * PI * f / sr;
    let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
    let mut mag = 1.0;
    for s in sections {
        let nr = s.b0 + s.b1 * c1 + s.b2 * c2;
        let ni = -(s.b1 * s1 + s.b2 * s2);
        let dr = 1.0 + s.a1 * c1 + s.a2 * c2;
        let di = -(s.a1 * s1 + s.a2 * s2);
        mag *= ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt();
    }
    20.0 * mag.max(1e-12).log10()
}

#[derive(Clone, Copy, Default)]
struct BiquadState {
    z1: f64,
    z2: f64,
}

/// Samples between coefficient updates while a band glides
const EQ_STEP: usize = 32;

fn glide(c: f32, t: f32, k: f32) -> f32 {
    let v = c + (t - c) * k;
    if (t - v).abs() < 1e-3 {
        t
    } else {
        v
    }
}

/// Glide on a log scale (frequency, Q), so an octave takes as long anywhere
fn glide_log(c: f32, t: f32, k: f32) -> f32 {
    if c <= 0.0 || t <= 0.0 {
        return t;
    }
    let v = c * (t / c).powf(k);
    if (v / t - 1.0).abs() < 1e-4 {
        t
    } else {
        v
    }
}

pub struct Eq {
    sample_rate: f32,
    /// Settings the filters glide towards, and the ones in use now
    target: Option<([BandSettings; MAX_BANDS], bool)>,
    cur: [BandSettings; MAX_BANDS],
    coefs: [[Coefs; STAGES_PER_BAND]; MAX_BANDS],
    state: [[BiquadState; STAGES_PER_BAND]; MAX_BANDS],
}

impl Eq {
    pub fn new(sample_rate: f32) -> Self {
        let flat = BandSettings { on: false, kind: BandType::Peaking, freq: 1000.0, gain_db: 0.0, q: 1.0, slope: 12 };
        Self { sample_rate, target: None, cur: [flat; MAX_BANDS], coefs: [[IDENTITY; STAGES_PER_BAND]; MAX_BANDS], state: [[BiquadState::default(); STAGES_PER_BAND]; MAX_BANDS] }
    }

    /// Frequency, gain and Q glide (automation and knob moves don't click); type, slope and
    /// on/off switch at once
    pub fn process(&mut self, buf: &mut [f32], bands: &[BandSettings; MAX_BANDS], on: bool) {
        match self.target {
            Some((t, o)) if t == *bands && o == on => {}
            Some((t, o)) => {
                let structural = o != on || t.iter().zip(bands.iter()).any(|(a, b)| a.on != b.on || a.kind != b.kind || a.slope != b.slope);
                self.target = Some((*bands, on));
                if structural {
                    self.cur = *bands;
                    self.update(on);
                }
            }
            None => {
                self.target = Some((*bands, on));
                self.cur = *bands;
                self.update(on);
            }
        }
        let k = 1.0 - (1.0 - coef(20.0, self.sample_rate)).powi(EQ_STEP as i32);
        for chunk in buf.chunks_mut(EQ_STEP) {
            if self.cur != *bands {
                for (c, t) in self.cur.iter_mut().zip(bands.iter()) {
                    c.freq = glide_log(c.freq, t.freq, k);
                    c.q = glide_log(c.q, t.q, k);
                    c.gain_db = glide(c.gain_db, t.gain_db, k);
                }
                self.update(on);
            }
            self.run(chunk);
        }
    }

    fn update(&mut self, on: bool) {
        for (i, b) in self.cur.iter().enumerate() {
            self.coefs[i] = band_stages(b, on, self.sample_rate);
        }
    }

    fn run(&mut self, buf: &mut [f32]) {
        for (bi, stages) in self.coefs.iter().enumerate() {
            for (si, c) in stages.iter().enumerate() {
                if *c == IDENTITY {
                    // Keep the state clean so switching a band back on doesn't click
                    self.state[bi][si] = BiquadState::default();
                    continue;
                }
                let st = &mut self.state[bi][si];
                for s in buf.iter_mut() {
                    let x = *s as f64;
                    let y = c.b0 * x + st.z1;
                    st.z1 = c.b1 * x - c.a1 * y + st.z2;
                    st.z2 = c.b2 * x - c.a2 * y;
                    *s = y as f32;
                }
                if st.z1.abs() < DENORMAL as f64 {
                    st.z1 = 0.0;
                }
                if st.z2.abs() < DENORMAL as f64 {
                    st.z2 = 0.0;
                }
            }
        }
    }
}

// ---- The whole chain

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ChainSettings {
    pub input_gain_db: f32,
    pub phase_invert: bool,
    pub noise: NoiseSettings,
    pub gate: GateSettings,
    pub eq_on: bool,
    pub eq_post: bool,
    pub bands: [BandSettings; MAX_BANDS],
    pub deesser: DeEsserSettings,
    pub comp1: CompSettings,
    pub comp2: CompSettings,
    pub saturation: SatSettings,
    pub limiter: LimiterSettings,
    pub output_gain_db: f32,
}

/// Levels of the last block, for the meters
#[derive(Clone, Copy, Default, Debug)]
pub struct ChainReport {
    pub noise_db: f32,
    pub gate_db: f32,
    pub deess_gr: f32,
    pub comp1_gr: f32,
    pub comp2_gr: f32,
    pub lim_gr: f32,
}

pub struct Chain {
    pub noise: Vec<NoiseSuppressor>,
    gate: Gate,
    eq: Vec<Eq>,
    deesser: DeEsser,
    comp1: Compressor,
    comp2: Compressor,
    sat: Vec<Saturator>,
    limiter: Limiter,
    in_gain: Smoother,
    out_gain: Smoother,
}

impl Chain {
    /// `channels` (1 or 2): noise reduction, EQ and saturation run per channel, the dynamics linked
    pub fn new(sample_rate: f32, channels: usize) -> Self {
        let n = channels.clamp(1, MAX_CHANNELS);
        Self {
            noise: (0..n).map(|_| NoiseSuppressor::new(sample_rate)).collect(),
            gate: Gate::new(sample_rate),
            eq: (0..n).map(|_| Eq::new(sample_rate)).collect(),
            deesser: DeEsser::new(sample_rate),
            comp1: Compressor::new(sample_rate),
            comp2: Compressor::new(sample_rate),
            sat: (0..n).map(|_| Saturator::new(sample_rate)).collect(),
            limiter: Limiter::new(sample_rate),
            in_gain: Smoother::new(sample_rate),
            out_gain: Smoother::new(sample_rate),
        }
    }

    /// Total latency in samples: noise reduction frame + saturator oversampling + limiter look-ahead
    /// (always, on or off)
    pub fn latency(&self) -> usize {
        self.noise[0].latency() + SAT_LATENCY + self.limiter.latency
    }

    /// Same order as the app: gain/phase → noise → gate → EQ (pre) → de-esser → comp 1 → comp 2
    /// → saturation → EQ (post) → limiter → output gain
    pub fn process(&mut self, bufs: &mut [&mut [f32]], s: &ChainSettings) -> ChainReport {
        let n = bufs.len().min(self.noise.len());
        let bufs = &mut bufs[..n];
        let len = block_len(bufs);
        // Gains glide too; a phase flip passes through zero instead of jumping
        let g_in = db_to_lin(s.input_gain_db) * if s.phase_invert { -1.0 } else { 1.0 };
        for i in 0..len {
            let g = self.in_gain.next(g_in);
            if g != 1.0 {
                bufs.iter_mut().for_each(|b| b[i] *= g);
            }
        }
        for (c, b) in bufs.iter_mut().enumerate() {
            self.noise[c].process(b, &s.noise);
        }
        self.gate.process(bufs, &s.gate);
        if !s.eq_post {
            for (c, b) in bufs.iter_mut().enumerate() {
                self.eq[c].process(b, &s.bands, s.eq_on);
            }
        }
        self.deesser.process(bufs, &s.deesser);
        self.comp1.process(bufs, &s.comp1);
        self.comp2.process(bufs, &s.comp2);
        for (c, b) in bufs.iter_mut().enumerate() {
            self.sat[c].process(b, &s.saturation);
        }
        if s.eq_post {
            for (c, b) in bufs.iter_mut().enumerate() {
                self.eq[c].process(b, &s.bands, s.eq_on);
            }
        }
        self.limiter.process(bufs, &s.limiter);
        let g_out = db_to_lin(s.output_gain_db);
        for i in 0..len {
            let g = self.out_gain.next(g_out);
            if g != 1.0 {
                bufs.iter_mut().for_each(|b| b[i] *= g);
            }
        }
        let noise_db = self.noise[..n].iter().fold(0.0f32, |m, ns| m.min(ns.reduction_db));
        ChainReport {
            noise_db: if s.noise.on { noise_db } else { 0.0 },
            gate_db: self.gate.block_gain_db,
            deess_gr: self.deesser.block_gr,
            comp1_gr: self.comp1.block_gr,
            comp2_gr: self.comp2.block_gr,
            lim_gr: self.limiter.block_gr,
        }
    }
}
