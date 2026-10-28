// The app's ProcessingChain as JSON (same fields and defaults as plugin/src/presets.rs, which
// depends on nih-plug and cannot be shared), and its translation to the DSP settings.
// The Android UI keeps the chain as this JSON, so preset files move freely between PC and phone.

use crate::dsp::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NoiseJson {
    pub on: bool,
    pub mode: String,
    pub reduction_db: f32,
    pub sensitivity_db: f32,
    pub smoothing: f32,
    pub from_hz: f32,
    pub resolution: u32,
    pub listen_removed: bool,
    pub profile: Option<Vec<f32>>,
}

impl Default for NoiseJson {
    fn default() -> Self {
        Self { on: false, mode: "adaptive".into(), reduction_db: -18.0, sensitivity_db: 0.0, smoothing: 50.0, from_hz: 0.0, resolution: 1024, listen_removed: false, profile: None }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GateJson {
    pub on: bool,
    pub mode: String,
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

impl Default for GateJson {
    fn default() -> Self {
        Self { on: false, mode: "expander".into(), threshold_db: -50.0, hysteresis_db: 4.0, range_db: -30.0, ratio: 2.0, attack_ms: 1.0, hold_ms: 120.0, release_ms: 180.0, key_hpf_hz: 0.0, key_lpf_hz: 0.0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BandJson {
    pub on: bool,
    #[serde(rename = "type")]
    pub kind: String,
    pub freq: f32,
    pub gain_db: f32,
    pub q: f32,
    pub slope: u32,
}

impl Default for BandJson {
    fn default() -> Self {
        Self { on: false, kind: "peaking".into(), freq: 1000.0, gain_db: 0.0, q: 1.0, slope: 12 }
    }
}

/// The app's flat starting EQ (type, Hz, Q, on, slope)
pub const DEFAULT_BANDS: [(&str, f32, f32, bool, u32); MAX_BANDS] = [
    ("highpass", 80.0, 0.71, true, 24),
    ("lowshelf", 150.0, 1.0, true, 12),
    ("peaking", 300.0, 1.2, true, 12),
    ("peaking", 800.0, 1.4, true, 12),
    ("peaking", 3000.0, 1.0, true, 12),
    ("peaking", 6500.0, 3.0, true, 12),
    ("highshelf", 10000.0, 1.0, true, 12),
    ("lowpass", 18000.0, 0.71, false, 12),
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct EqJson {
    pub on: bool,
    pub bands: Vec<BandJson>,
}

impl Default for EqJson {
    fn default() -> Self {
        let bands = DEFAULT_BANDS.iter().map(|&(kind, freq, q, on, slope)| BandJson { on, kind: kind.into(), freq, gain_db: 0.0, q, slope }).collect();
        Self { on: true, bands }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DeEsserJson {
    pub on: bool,
    pub freq: f32,
    pub q: f32,
    pub threshold_db: f32,
    pub ratio: f32,
    pub range_db: f32,
    pub mode: String,
    pub listen: bool,
}

impl Default for DeEsserJson {
    fn default() -> Self {
        Self { on: false, freq: 6500.0, q: 1.4, threshold_db: -30.0, ratio: 4.0, range_db: -8.0, mode: "split".into(), listen: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CompJson {
    pub on: bool,
    pub threshold_db: f32,
    pub ratio: f32,
    pub knee_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    pub auto_makeup: bool,
    pub mix: f32,
    pub detector: String,
    pub sc_hpf_hz: f32,
}

impl Default for CompJson {
    fn default() -> Self {
        Self { on: false, threshold_db: -18.0, ratio: 4.0, knee_db: 6.0, attack_ms: 5.0, release_ms: 80.0, makeup_db: 4.0, auto_makeup: false, mix: 100.0, detector: "peak".into(), sc_hpf_hz: 0.0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SatJson {
    pub on: bool,
    pub mode: String,
    pub drive_db: f32,
    pub tone_hz: f32,
    pub mix: f32,
}

impl Default for SatJson {
    fn default() -> Self {
        Self { on: false, mode: "tube".into(), drive_db: 6.0, tone_hz: 12000.0, mix: 35.0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LimiterJson {
    pub on: bool,
    pub ceiling_db: f32,
    pub release_ms: f32,
}

impl Default for LimiterJson {
    fn default() -> Self {
        Self { on: true, ceiling_db: -1.0, release_ms: 60.0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct ChainJson {
    pub noise: NoiseJson,
    pub gate: GateJson,
    pub eq: EqJson,
    pub deesser: DeEsserJson,
    pub comp1: CompJson,
    pub comp2: CompJson,
    pub saturation: SatJson,
    pub limiter: LimiterJson,
}

impl Default for ChainJson {
    fn default() -> Self {
        Self {
            noise: NoiseJson::default(),
            gate: GateJson::default(),
            eq: EqJson::default(),
            deesser: DeEsserJson::default(),
            comp1: CompJson::default(),
            comp2: CompJson { threshold_db: -24.0, ratio: 2.0, knee_db: 10.0, attack_ms: 30.0, release_ms: 400.0, makeup_db: 2.0, detector: "rms".into(), ..CompJson::default() },
            saturation: SatJson::default(),
            limiter: LimiterJson::default(),
        }
    }
}

pub fn parse_chain(text: &str) -> ChainJson {
    serde_json::from_str(text).unwrap_or_default()
}

/// Any (possibly partial) chain with every field filled in with the app's defaults
pub fn normalize_chain(text: &str) -> String {
    serde_json::to_string(&parse_chain(text)).unwrap_or_default()
}

pub fn band_type(s: &str) -> BandType {
    match s {
        "lowshelf" => BandType::LowShelf,
        "highshelf" => BandType::HighShelf,
        "highpass" => BandType::Highpass,
        "lowpass" => BandType::Lowpass,
        "notch" => BandType::Notch,
        "bandpass" => BandType::Bandpass,
        _ => BandType::Peaking,
    }
}

pub fn band_settings(c: &ChainJson) -> [BandSettings; MAX_BANDS] {
    std::array::from_fn(|i| {
        let b = c.eq.bands.get(i).cloned().unwrap_or_default();
        BandSettings { on: b.on && i < c.eq.bands.len(), kind: band_type(&b.kind), freq: b.freq, gain_db: b.gain_db, q: b.q, slope: b.slope }
    })
}

/// DSP settings of an app chain plus the processor's input / output gains (EQ before the compressors)
pub fn settings_of(c: &ChainJson, input_gain_db: f32, output_gain_db: f32) -> ChainSettings {
    let comp = |j: &CompJson| CompSettings {
        on: j.on,
        threshold_db: j.threshold_db,
        ratio: j.ratio,
        knee_db: j.knee_db,
        attack_ms: j.attack_ms,
        release_ms: j.release_ms,
        makeup_db: j.makeup_db,
        auto_makeup: j.auto_makeup,
        mix: j.mix,
        detector: if j.detector == "rms" { Detector::Rms } else { Detector::Peak },
        sc_hpf_hz: j.sc_hpf_hz,
    };
    ChainSettings {
        input_gain_db,
        phase_invert: false,
        noise: NoiseSettings {
            on: c.noise.on,
            mode: if c.noise.mode == "learned" { NoiseMode::Learned } else { NoiseMode::Adaptive },
            reduction_db: c.noise.reduction_db,
            sensitivity_db: c.noise.sensitivity_db,
            smoothing: c.noise.smoothing,
            from_hz: c.noise.from_hz,
            listen_removed: c.noise.listen_removed,
        },
        gate: GateSettings {
            on: c.gate.on,
            mode: if c.gate.mode == "gate" { GateMode::Gate } else { GateMode::Expander },
            threshold_db: c.gate.threshold_db,
            hysteresis_db: c.gate.hysteresis_db,
            range_db: c.gate.range_db,
            ratio: c.gate.ratio,
            attack_ms: c.gate.attack_ms,
            hold_ms: c.gate.hold_ms,
            release_ms: c.gate.release_ms,
            key_hpf_hz: c.gate.key_hpf_hz,
            key_lpf_hz: c.gate.key_lpf_hz,
        },
        eq_on: c.eq.on,
        eq_post: false,
        bands: band_settings(c),
        deesser: DeEsserSettings {
            on: c.deesser.on,
            freq: c.deesser.freq,
            q: c.deesser.q,
            threshold_db: c.deesser.threshold_db,
            ratio: c.deesser.ratio,
            range_db: c.deesser.range_db,
            mode: if c.deesser.mode == "wide" { DeEssMode::Wide } else { DeEssMode::Split },
            listen: c.deesser.listen,
        },
        comp1: comp(&c.comp1),
        comp2: comp(&c.comp2),
        saturation: SatSettings {
            on: c.saturation.on,
            mode: match c.saturation.mode.as_str() {
                "tape" => SatMode::Tape,
                "amp" => SatMode::Amp,
                _ => SatMode::Tube,
            },
            drive_db: c.saturation.drive_db,
            tone_hz: c.saturation.tone_hz,
            mix: c.saturation.mix,
        },
        limiter: LimiterSettings { on: c.limiter.on, ceiling_db: c.limiter.ceiling_db, release_ms: c.limiter.release_ms },
        output_gain_db,
    }
}

/// EQ magnitude response (dB) of a chain at each frequency
pub fn eq_response(c: &ChainJson, sample_rate: f32, freqs: &[f32], out: &mut [f32]) {
    let bands = band_settings(c);
    let sections: Vec<Coefs> = bands.iter().flat_map(|b| band_stages(b, c.eq.on, sample_rate)).collect();
    for (o, &f) in out.iter_mut().zip(freqs) {
        *o = response_db(&sections, f as f64, sample_rate as f64) as f32;
    }
}
