// One processor instance: the plugin's Chain plus what the Android UI needs around it: interleaved
// I/O, A/B bypass aligned with the chain's latency, meters held until read, LUFS (EBU R128),
// the noise profile, and rings of the latest samples for the spectrum and the tuner.

use crate::chain::*;
use crate::dsp::*;

/// Longest block the engine processes at once (longer ones are split)
pub const MAX_BLOCK: usize = 4096;
/// Samples kept for the spectrum (FFT size) and the tuner
pub const RING: usize = 4096;

// ---- EBU R128 loudness (K-weighting, 400 ms momentary, 3 s short-term, gated integrated)

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// ITU-R BS.1770 K-weighting (libebur128 formulas, as core/studio/dsp.ts)
fn k_weighting(sr: f64) -> [Biquad; 2] {
    let (f0, g, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
    let k = (std::f64::consts::PI * f0 / sr).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad { b0: (vh + vb * k / q + k * k) / a0, b1: 2.0 * (k * k - vh) / a0, b2: (vh - vb * k / q + k * k) / a0, a1: 2.0 * (k * k - 1.0) / a0, a2: (1.0 - k / q + k * k) / a0, ..Default::default() };
    let (f0, q) = (38.13547087602444, 0.5003270373238773);
    let k = (std::f64::consts::PI * f0 / sr).tan();
    let a0 = 1.0 + k / q + k * k;
    let hp = Biquad { b0: 1.0, b1: -2.0, b2: 1.0, a1: 2.0 * (k * k - 1.0) / a0, a2: (1.0 - k / q + k * k) / a0, ..Default::default() };
    [shelf, hp]
}

pub struct Loudness {
    filters: Vec<[Biquad; 2]>,
    /// Mean square of every 100 ms step (summed over channels)
    steps: Vec<f64>,
    acc: f64,
    acc_n: usize,
    step_len: usize,
    /// Mean squares of every 400 ms block (75 % overlap), for the integrated value
    blocks: Vec<f64>,
}

pub fn energy_lufs(ms: f64) -> f32 {
    if ms <= 1e-12 {
        -100.0
    } else {
        (-0.691 + 10.0 * ms.log10()) as f32
    }
}

impl Loudness {
    pub fn new(sr: f32, channels: usize) -> Self {
        Self { filters: (0..channels).map(|_| k_weighting(sr as f64)).collect(), steps: Vec::new(), acc: 0.0, acc_n: 0, step_len: (sr / 10.0).round() as usize, blocks: Vec::new() }
    }

    pub fn reset(&mut self) {
        let ch = self.filters.len();
        let sr = self.step_len as f32 * 10.0;
        *self = Self::new(sr, ch);
    }

    /// `bufs`: one slice per channel
    pub fn push(&mut self, bufs: &[&mut [f32]], len: usize) {
        for i in 0..len {
            let mut s = 0.0;
            for (c, b) in bufs.iter().enumerate() {
                let f = &mut self.filters[c];
                let x = f[0].run(b[i] as f64);
                let y = f[1].run(x);
                s += y * y;
            }
            self.acc += s;
            self.acc_n += 1;
            if self.acc_n >= self.step_len {
                self.steps.push(self.acc / self.acc_n as f64);
                self.acc = 0.0;
                self.acc_n = 0;
                if self.steps.len() >= 4 {
                    let n = self.steps.len();
                    self.blocks.push(self.steps[n - 4..].iter().sum::<f64>() / 4.0);
                }
                // Short-term needs the last 30 steps; keep a little more
                if self.steps.len() > 600 {
                    self.steps.drain(..300);
                }
            }
        }
    }

    fn window(&self, n: usize) -> f32 {
        if self.steps.len() < n {
            return -100.0;
        }
        let k = self.steps.len();
        energy_lufs(self.steps[k - n..].iter().sum::<f64>() / n as f64)
    }

    pub fn momentary(&self) -> f32 {
        self.window(4)
    }

    pub fn short_term(&self) -> f32 {
        self.window(30)
    }

    /// Gated integrated loudness (absolute −70 LUFS gate, then relative −10 LU)
    pub fn integrated(&self) -> f32 {
        let abs: Vec<f64> = self.blocks.iter().copied().filter(|&m| energy_lufs(m) > -70.0).collect();
        if abs.is_empty() {
            return -100.0;
        }
        let rel = energy_lufs(abs.iter().sum::<f64>() / abs.len() as f64) - 10.0;
        let gated: Vec<f64> = abs.into_iter().filter(|&m| energy_lufs(m) > rel).collect();
        if gated.is_empty() {
            return -100.0;
        }
        energy_lufs(gated.iter().sum::<f64>() / gated.len() as f64)
    }
}

// ---- True peak (4× windowed-sinc interpolation, as the app's meter)

pub struct TruePeak {
    phases: Vec<[f32; 12]>,
    hist: Vec<[f32; 12]>,
    pos: usize,
}

impl TruePeak {
    pub fn new(channels: usize) -> Self {
        let n = 48;
        let mid = (n - 1) as f64 / 2.0;
        let h: Vec<f64> = (0..n)
            .map(|i| {
                let x = (i as f64 - mid) / 4.0;
                let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
                let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (n - 1) as f64).cos();
                sinc * w
            })
            .collect();
        let phases = (0..4)
            .map(|p| {
                let mut t = [0f32; 12];
                let sum: f64 = (0..12).map(|k| h[k * 4 + p]).sum();
                for k in 0..12 {
                    t[k] = (h[k * 4 + p] / sum) as f32;
                }
                t
            })
            .collect();
        Self { phases, hist: vec![[0.0; 12]; channels], pos: 0 }
    }

    /// Highest inter-sample peak of the block (linear)
    pub fn push(&mut self, bufs: &[&mut [f32]], len: usize) -> f32 {
        let mut peak = 0f32;
        let start = self.pos;
        for (c, b) in bufs.iter().enumerate() {
            let mut pos = start;
            let h = &mut self.hist[c];
            for &x in b[..len].iter() {
                h[pos] = x;
                pos = (pos + 1) % 12;
                for ph in &self.phases {
                    let mut y = 0f32;
                    for (k, &t) in ph.iter().enumerate() {
                        y += t * h[(pos + k) % 12];
                    }
                    peak = peak.max(y.abs());
                }
            }
            if c + 1 == bufs.len() {
                self.pos = pos;
            }
        }
        peak
    }
}

// ---- Pitch (YIN, as core/studio/pitch.ts)

/// (Hz, clarity 0..1) or None when the frame isn't pitched
pub fn detect_pitch(buf: &[f32], sr: f32, min_hz: f32, max_hz: f32, threshold: f64) -> Option<(f32, f32)> {
    let max_tau = ((sr / min_hz) as usize).min(buf.len() / 2);
    let min_tau = ((sr / max_hz) as usize).max(2);
    if max_tau <= min_tau + 2 {
        return None;
    }
    let w = buf.len() - max_tau;
    let energy: f64 = buf.iter().map(|&x| (x as f64) * (x as f64)).sum();
    if energy / (buf.len() as f64) < 1e-7 {
        return None;
    }
    let mut d = vec![0f64; max_tau + 1];
    for (tau, dv) in d.iter_mut().enumerate().skip(1) {
        let mut sum = 0f64;
        for i in 0..w {
            let diff = (buf[i] - buf[i + tau]) as f64;
            sum += diff * diff;
        }
        *dv = sum;
    }
    let mut cmnd = vec![1f64; max_tau + 1];
    let mut running = 0f64;
    for tau in 1..=max_tau {
        running += d[tau];
        cmnd[tau] = if running > 0.0 { d[tau] * tau as f64 / running } else { 1.0 };
    }
    let mut found = None;
    let mut t = min_tau;
    while t <= max_tau {
        if cmnd[t] < threshold {
            while t < max_tau && cmnd[t + 1] < cmnd[t] {
                t += 1;
            }
            found = Some(t);
            break;
        }
        t += 1;
    }
    let tau = found?;
    let mut refined = tau as f64;
    if tau > 1 && tau < max_tau {
        let (a, b, c) = (cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]);
        let den = a - 2.0 * b + c;
        if den != 0.0 {
            refined = tau as f64 + (0.5 * (a - c) / den).clamp(-0.5, 0.5);
        }
    }
    let hz = (sr as f64 / refined) as f32;
    if hz < min_hz || hz > max_hz {
        return None;
    }
    Some((hz, (1.0 - cmnd[tau]).clamp(0.0, 1.0) as f32))
}

// ---- The engine

struct Ring {
    buf: Vec<f32>,
    pos: usize,
}

impl Ring {
    fn new() -> Self {
        Self { buf: vec![0.0; RING], pos: 0 }
    }
    fn push(&mut self, data: &[f32]) {
        for &x in data {
            self.buf[self.pos] = x;
            self.pos = (self.pos + 1) % RING;
        }
    }
    fn ordered(&self, out: &mut [f32]) {
        for (i, o) in out.iter_mut().enumerate().take(RING) {
            *o = self.buf[(self.pos + i) % RING];
        }
    }
}

/// Meter values held (loudest / deepest) since the UI last read them
#[derive(Clone, Copy)]
pub struct Held {
    pub in_peak: f32,
    pub in_rms: f32,
    pub out_peak: f32,
    pub out_rms: f32,
    pub noise_db: f32,
    pub gate_db: f32,
    pub deess_gr: f32,
    pub comp1_gr: f32,
    pub comp2_gr: f32,
    pub lim_gr: f32,
    pub true_peak: f32,
}

impl Default for Held {
    fn default() -> Self {
        Self { in_peak: -100.0, in_rms: -100.0, out_peak: -100.0, out_rms: -100.0, noise_db: 0.0, gate_db: 0.0, deess_gr: 0.0, comp1_gr: 0.0, comp2_gr: 0.0, lim_gr: 0.0, true_peak: -100.0 }
    }
}

pub struct Engine {
    pub sample_rate: f32,
    pub channels: usize,
    chain: Chain,
    settings: ChainSettings,
    pub chain_json: ChainJson,
    pub input_gain_db: f32,
    pub bypass: bool,
    /// Dry signal delayed by the chain's latency, so A/B switches without a jump in time
    dry: Vec<Vec<f32>>,
    dry_pos: usize,
    scratch: Vec<Vec<f32>>,
    raw: Vec<Vec<f32>>,
    in_ring: Ring,
    out_ring: Ring,
    pub held: Held,
    pub loudness: Loudness,
    true_peak: TruePeak,
    /// Highest true peak since the loudness was reset (for exports)
    pub true_peak_max: f32,
    loaded_profile: Option<Vec<f32>>,
}

fn peak_rms(b: &[f32]) -> (f32, f32) {
    let mut p = 0f32;
    let mut s = 0f64;
    for &x in b {
        p = p.max(x.abs());
        s += (x as f64) * (x as f64);
    }
    (lin_to_db(p), if b.is_empty() { -100.0 } else { (10.0 * (s / b.len() as f64).max(1e-20).log10()) as f32 })
}

impl Engine {
    pub fn new(sample_rate: f32, channels: usize) -> Self {
        let channels = channels.clamp(1, MAX_CHANNELS);
        let chain = Chain::new(sample_rate, channels);
        let lat = chain.latency();
        let json = ChainJson::default();
        Self {
            sample_rate,
            channels,
            settings: settings_of(&json, 0.0, 0.0),
            chain,
            chain_json: json,
            input_gain_db: 0.0,
            bypass: false,
            dry: vec![vec![0.0; lat.max(1)]; channels],
            dry_pos: 0,
            scratch: vec![vec![0.0; MAX_BLOCK]; channels],
            raw: vec![vec![0.0; MAX_BLOCK]; channels],
            in_ring: Ring::new(),
            out_ring: Ring::new(),
            held: Held::default(),
            loudness: Loudness::new(sample_rate, channels),
            true_peak: TruePeak::new(channels),
            true_peak_max: 0.0,
            loaded_profile: None,
        }
    }

    pub fn latency(&self) -> usize {
        self.chain.latency()
    }

    pub fn set_chain(&mut self, chain: ChainJson, input_gain_db: f32, output_gain_db: f32, bypass: bool) {
        self.settings = settings_of(&chain, input_gain_db, output_gain_db);
        if chain.noise.profile != self.loaded_profile {
            for ns in self.chain.noise.iter_mut() {
                let bins = ns.bins();
                ns.set_profile(chain.noise.profile.as_ref().filter(|p| p.len() > 1).map(|p| resample_profile(p, bins)));
            }
            self.loaded_profile = chain.noise.profile.clone();
        }
        self.chain_json = chain;
        self.input_gain_db = input_gain_db;
        self.bypass = bypass;
    }

    pub fn learn_noise(&mut self, seconds: f32) {
        self.chain.noise.iter_mut().for_each(|ns| ns.learn(seconds));
    }

    pub fn learning(&self) -> bool {
        self.chain.noise.iter().any(|ns| ns.learning())
    }

    pub fn take_learned(&mut self) -> Option<Vec<f32>> {
        let p = self.chain.noise[0].take_learned();
        for ns in self.chain.noise.iter_mut().skip(1) {
            ns.take_learned();
        }
        p
    }

    /// Processes `frames` interleaved frames in place
    pub fn process(&mut self, data: &mut [f32], frames: usize) {
        let ch = self.channels;
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(MAX_BLOCK);
            self.process_block(&mut data[done * ch..(done + n) * ch], n);
            done += n;
        }
    }

    fn process_block(&mut self, data: &mut [f32], n: usize) {
        let ch = self.channels;
        for c in 0..ch {
            for i in 0..n {
                let x = data[i * ch + c];
                self.scratch[c][i] = x;
                self.raw[c][i] = x;
            }
        }
        let gain_in = db_to_lin(self.input_gain_db);
        {
            let (p, r) = peak_rms(&self.raw[0][..n]);
            let g = lin_to_db(gain_in);
            self.held.in_peak = self.held.in_peak.max(p + g);
            self.held.in_rms = self.held.in_rms.max(r + g);
            // The tuner and the input spectrum see the signal after the input gain
            if gain_in == 1.0 {
                self.in_ring.push(&self.raw[0][..n]);
            } else {
                for i in 0..n {
                    let x = self.raw[0][i] * gain_in;
                    self.in_ring.buf[self.in_ring.pos] = x;
                    self.in_ring.pos = (self.in_ring.pos + 1) % RING;
                }
            }
        }
        let report = {
            let mut bufs: Vec<&mut [f32]> = self.scratch.iter_mut().map(|b| &mut b[..n]).collect();
            self.chain.process(&mut bufs, &self.settings)
        };
        // Dry path, delayed to line up with the processed one
        let lat = self.dry[0].len();
        for i in 0..n {
            let pos = (self.dry_pos + i) % lat;
            for c in 0..ch {
                let delayed = self.dry[c][pos];
                self.dry[c][pos] = self.raw[c][i];
                self.raw[c][i] = delayed;
            }
        }
        self.dry_pos = (self.dry_pos + n) % lat;
        let out = if self.bypass { &mut self.raw } else { &mut self.scratch };
        {
            let (p, r) = peak_rms(&out[0][..n]);
            self.held.out_peak = self.held.out_peak.max(p);
            self.held.out_rms = self.held.out_rms.max(r);
            self.out_ring.push(&out[0][..n]);
            let bufs: Vec<&mut [f32]> = out.iter_mut().map(|b| &mut b[..n]).collect();
            self.loudness.push(&bufs, n);
            let tp = self.true_peak.push(&bufs, n);
            self.true_peak_max = self.true_peak_max.max(tp);
            self.held.true_peak = self.held.true_peak.max(lin_to_db(tp));
        }
        for c in 0..ch {
            for i in 0..n {
                data[i * ch + c] = out[c][i];
            }
        }
        let h = &mut self.held;
        h.noise_db = h.noise_db.min(report.noise_db);
        h.gate_db = h.gate_db.min(report.gate_db);
        h.deess_gr = h.deess_gr.min(report.deess_gr);
        h.comp1_gr = h.comp1_gr.min(report.comp1_gr);
        h.comp2_gr = h.comp2_gr.min(report.comp2_gr);
        h.lim_gr = h.lim_gr.min(report.lim_gr);
    }

    /// Meters for the UI; the held values restart
    pub fn take_meters(&mut self) -> [f32; 15] {
        let h = std::mem::take(&mut self.held);
        [
            h.in_peak,
            h.in_rms,
            h.out_peak,
            h.out_rms,
            h.noise_db,
            h.gate_db,
            h.deess_gr,
            h.comp1_gr,
            h.comp2_gr,
            h.lim_gr,
            self.loudness.momentary(),
            self.loudness.short_term(),
            h.true_peak,
            if self.learning() { 1.0 } else { 0.0 },
            self.latency() as f32 / self.sample_rate * 1000.0,
        ]
    }

    /// Copy of the latest RING samples (input after its gain, or output), oldest first
    pub fn snapshot(&self, output: bool, out: &mut [f32]) {
        if output {
            self.out_ring.ordered(out)
        } else {
            self.in_ring.ordered(out)
        }
    }

    pub fn reset_loudness(&mut self) {
        self.loudness.reset();
        self.true_peak_max = 0.0;
    }
}

/// Hann-windowed power spectrum of RING samples, dB per bin (RING / 2 bins)
pub fn spectrum_db(samples: &[f32], out: &mut [f32]) {
    let n = RING;
    let mut re: Vec<f64> = (0..n).map(|i| samples[i] as f64 * (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos())).collect();
    let mut im = vec![0f64; n];
    fft(&mut re, &mut im);
    // Hann coherent gain 0.5: a full-scale sine reads about 0 dB
    let scale = 2.0 / (n as f64 * 0.5);
    for (k, o) in out.iter_mut().enumerate().take(n / 2) {
        let m = (re[k] * re[k] + im[k] * im[k]).sqrt() * scale;
        *o = (20.0 * m.max(1e-10).log10()) as f32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, sr: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / sr).sin()).collect()
    }

    #[test]
    fn processes_and_meters() {
        let mut e = Engine::new(48000.0, 1);
        let mut s = sine(440.0, 48000.0, 48000, 0.5);
        e.process(&mut s, 48000);
        let m = e.take_meters();
        assert!((m[0] - lin_to_db(0.5)).abs() < 0.1, "in peak {}", m[0]);
        assert!(m[2] <= -0.9, "limited to the ceiling: {}", m[2]);
        assert!(s.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn bypass_is_the_delayed_input() {
        let mut e = Engine::new(48000.0, 1);
        let chain = parse_chain(r#"{"comp1":{"on":true,"ratio":10,"thresholdDb":-40}}"#);
        e.set_chain(chain, 0.0, 0.0, true);
        let input = sine(220.0, 48000.0, 8192, 0.3);
        let mut s = input.clone();
        e.process(&mut s, 8192);
        let lat = e.latency();
        for i in lat..8192 {
            assert!((s[i] - input[i - lat]).abs() < 1e-6);
        }
    }

    #[test]
    fn loudness_of_a_sine() {
        // EBU: a 1 kHz sine at −20 dBFS (mono) reads about −23 LUFS... at 0 dBFS peak −3.01 dB RMS
        let mut l = Loudness::new(48000.0, 1);
        let mut s = sine(1000.0, 48000.0, 48000 * 5, 0.1);
        let bufs = [&mut s[..]];
        l.push(&bufs, 48000 * 5);
        let i = l.integrated();
        assert!((i - (-23.0)).abs() < 0.3, "integrated {i}");
        assert!((l.short_term() - i).abs() < 0.3);
    }

    #[test]
    fn yin_finds_a_note() {
        let s = sine(110.0, 48000.0, RING, 0.5);
        let (hz, clarity) = detect_pitch(&s, 48000.0, 30.0, 1500.0, 0.15).unwrap();
        assert!((hz - 110.0).abs() < 0.5, "{hz}");
        assert!(clarity > 0.9);
    }

    #[test]
    fn chain_json_round_trip_with_defaults() {
        let text = normalize_chain(r#"{"comp1":{"on":true,"ratio":8},"eq":{"on":true,"bands":[{"on":true,"type":"highpass","freq":120,"gainDb":0,"q":0.71,"slope":24}]}}"#);
        let c = parse_chain(&text);
        assert!(c.comp1.on);
        assert_eq!(c.comp1.threshold_db, -18.0);
        assert_eq!(c.eq.bands.len(), 1);
        assert_eq!(c.limiter.ceiling_db, -1.0);
        assert_eq!(c.comp2.detector, "rms");
    }

    #[test]
    fn presets_bundle_parses() {
        let raw: serde_json::Value = serde_json::from_str(include_str!("../../../plugin/presets.json")).unwrap();
        let chains = raw["chains"].as_object().unwrap();
        assert!(chains.len() > 50);
        for (k, v) in chains {
            let c: ChainJson = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{k}: {e}"));
            let mut e = Engine::new(48000.0, 2);
            e.set_chain(c, 0.0, 0.0, false);
            let mut s = sine(300.0, 48000.0, 2048, 0.3).into_iter().flat_map(|x| [x, x]).collect::<Vec<_>>();
            e.process(&mut s, 1024);
            assert!(s.iter().all(|x| x.is_finite()), "{k}");
        }
    }
}
