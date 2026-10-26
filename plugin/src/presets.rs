// Presets: the app's preset files ({ app: "gritometro-procesador", chain }) and the built-in
// use × mic presets generated from the app into presets.json (npm run plugin:presets).

use crate::params::*;
use nih_plug::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

pub const PRESET_APP: &str = "gritometro-procesador";

// ---- The app's ProcessingChain, field for field (missing fields take the app's defaults)

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct EqJson {
    pub on: bool,
    pub bands: Vec<BandJson>,
}

impl Default for EqJson {
    fn default() -> Self {
        let bands = DEFAULT_BANDS.iter().map(|&(kind, freq, q, on, slope)| BandJson { on, kind: kind.to_app().into(), freq, gain_db: 0.0, q, slope: slope.db() }).collect();
        Self { on: true, bands }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Debug)]
pub struct PresetFile {
    pub app: String,
    pub version: u32,
    pub name: String,
    pub chain: ChainJson,
}

pub fn parse_preset_file(text: &str) -> Result<(String, ChainJson), String> {
    let raw: serde_json::Value = serde_json::from_str(text).map_err(|_| "El archivo no es un JSON válido.".to_string())?;
    if raw.get("app").and_then(|v| v.as_str()) != Some(PRESET_APP) || raw.get("chain").is_none() {
        return Err("No es un preset del procesador.".into());
    }
    let name = raw.get("name").and_then(|v| v.as_str()).unwrap_or("Preset importado").to_string();
    let chain: ChainJson = serde_json::from_value(raw["chain"].clone()).map_err(|e| format!("Preset dañado: {e}"))?;
    Ok((name, chain))
}

pub fn serialize_preset_file(name: &str, chain: ChainJson) -> String {
    serde_json::to_string_pretty(&PresetFile { app: PRESET_APP.into(), version: 1, name: name.into(), chain }).unwrap_or_default()
}

// ---- Built-in presets (generated from the app)

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UseInfo {
    pub id: String,
    pub name: String,
    pub hint: String,
    pub group: String,
    pub default_mic: String,
    pub mics: Vec<String>,
}

#[derive(Deserialize, Debug)]
pub struct MicInfo {
    pub id: String,
    pub name: String,
    pub hint: String,
    pub group: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub groups: Vec<(String, String)>,
    pub mic_groups: Vec<(String, String)>,
    pub uses: Vec<UseInfo>,
    pub mics: Vec<MicInfo>,
    pub chains: HashMap<String, ChainJson>,
}

pub fn bundle() -> &'static Bundle {
    static B: OnceLock<Bundle> = OnceLock::new();
    B.get_or_init(|| serde_json::from_str(include_str!("../presets.json")).expect("presets.json"))
}

// ---- Params ↔ chain

fn set_f(setter: &ParamSetter, p: &FloatParam, v: f32) {
    setter.begin_set_parameter(p);
    setter.set_parameter(p, v);
    setter.end_set_parameter(p);
}

fn set_b(setter: &ParamSetter, p: &BoolParam, v: bool) {
    setter.begin_set_parameter(p);
    setter.set_parameter(p, v);
    setter.end_set_parameter(p);
}

fn set_e<T: Enum + PartialEq + 'static>(setter: &ParamSetter, p: &EnumParam<T>, v: T) {
    setter.begin_set_parameter(p);
    setter.set_parameter(p, v);
    setter.end_set_parameter(p);
}

fn apply_comp(setter: &ParamSetter, p: &CompParams, c: &CompJson) {
    set_b(setter, &p.on, c.on);
    set_f(setter, &p.threshold, c.threshold_db);
    set_f(setter, &p.ratio, c.ratio);
    set_f(setter, &p.knee, c.knee_db);
    set_f(setter, &p.attack, c.attack_ms);
    set_f(setter, &p.release, c.release_ms);
    set_f(setter, &p.makeup, c.makeup_db);
    set_b(setter, &p.auto_makeup, c.auto_makeup);
    set_f(setter, &p.mix, c.mix);
    set_e(setter, &p.detector, if c.detector == "rms" { DetectorP::Rms } else { DetectorP::Peak });
    set_f(setter, &p.sc_hpf, c.sc_hpf_hz);
}

/// Sets every processing parameter from a chain (gains, phase and EQ position stay as they are,
/// like loading a preset in the app). Returns the noise profile it carries, if any.
pub fn apply_chain(setter: &ParamSetter, p: &ProcParams, c: &ChainJson) -> Option<Vec<f32>> {
    let n = &c.noise;
    set_b(setter, &p.noise.on, n.on);
    set_e(setter, &p.noise.mode, if n.mode == "learned" { NoiseModeP::Learned } else { NoiseModeP::Adaptive });
    set_f(setter, &p.noise.reduction, n.reduction_db);
    set_f(setter, &p.noise.sensitivity, n.sensitivity_db);
    set_f(setter, &p.noise.smoothing, n.smoothing);
    set_f(setter, &p.noise.from_hz, n.from_hz);
    set_b(setter, &p.noise.listen_removed, false);

    let g = &c.gate;
    set_b(setter, &p.gate.on, g.on);
    set_e(setter, &p.gate.mode, if g.mode == "gate" { GateModeP::Gate } else { GateModeP::Expander });
    set_f(setter, &p.gate.threshold, g.threshold_db);
    set_f(setter, &p.gate.hysteresis, g.hysteresis_db);
    set_f(setter, &p.gate.range, g.range_db);
    set_f(setter, &p.gate.ratio, g.ratio);
    set_f(setter, &p.gate.attack, g.attack_ms);
    set_f(setter, &p.gate.hold, g.hold_ms);
    set_f(setter, &p.gate.release, g.release_ms);
    set_f(setter, &p.gate.key_hpf, g.key_hpf_hz);
    set_f(setter, &p.gate.key_lpf, g.key_lpf_hz);

    set_b(setter, &p.eq_on, c.eq.on);
    for (i, bp) in p.bands.iter().enumerate() {
        // The app may have fewer than eight bands: the rest are switched off
        let b = c.eq.bands.get(i).cloned().unwrap_or_default();
        set_b(setter, &bp.on, b.on && i < c.eq.bands.len());
        set_e(setter, &bp.kind, BandTypeP::from_app(&b.kind));
        set_f(setter, &bp.freq, b.freq);
        set_f(setter, &bp.gain, b.gain_db);
        set_f(setter, &bp.q, b.q);
        set_e(setter, &bp.slope, SlopeP::from_db(b.slope));
    }

    let d = &c.deesser;
    set_b(setter, &p.deesser.on, d.on);
    set_e(setter, &p.deesser.mode, if d.mode == "wide" { DeEssModeP::Wide } else { DeEssModeP::Split });
    set_f(setter, &p.deesser.freq, d.freq);
    set_f(setter, &p.deesser.q, d.q);
    set_f(setter, &p.deesser.threshold, d.threshold_db);
    set_f(setter, &p.deesser.ratio, d.ratio);
    set_f(setter, &p.deesser.range, d.range_db);
    set_b(setter, &p.deesser.listen, false);

    apply_comp(setter, &p.comp1, &c.comp1);
    apply_comp(setter, &p.comp2, &c.comp2);

    let s = &c.saturation;
    set_b(setter, &p.saturation.on, s.on);
    set_e(setter, &p.saturation.mode, match s.mode.as_str() {
        "tape" => SatModeP::Tape,
        "amp" => SatModeP::Amp,
        _ => SatModeP::Tube,
    });
    set_f(setter, &p.saturation.drive, s.drive_db);
    set_f(setter, &p.saturation.tone, s.tone_hz);
    set_f(setter, &p.saturation.mix, s.mix);

    set_b(setter, &p.limiter.on, c.limiter.on);
    set_f(setter, &p.limiter.ceiling, c.limiter.ceiling_db);
    set_f(setter, &p.limiter.release, c.limiter.release_ms);
    n.profile.clone().filter(|p| p.len() > 1)
}

fn comp_json(p: &CompParams) -> CompJson {
    CompJson {
        on: p.on.value(),
        threshold_db: p.threshold.value(),
        ratio: p.ratio.value(),
        knee_db: p.knee.value(),
        attack_ms: p.attack.value(),
        release_ms: p.release.value(),
        makeup_db: p.makeup.value(),
        auto_makeup: p.auto_makeup.value(),
        mix: p.mix.value(),
        detector: if p.detector.value() == DetectorP::Rms { "rms" } else { "peak" }.into(),
        sc_hpf_hz: off_hz(p.sc_hpf.value()),
    }
}

/// The current processing as an app chain (to save a preset the app can load)
pub fn chain_of(p: &ProcParams) -> ChainJson {
    let r = |v: f32| (v * 100.0).round() / 100.0;
    let profile = p.noise_profile.read().ok().map(|v| v.clone()).filter(|v| !v.is_empty());
    ChainJson {
        noise: NoiseJson {
            on: p.noise.on.value(),
            mode: if p.noise.mode.value() == NoiseModeP::Learned { "learned" } else { "adaptive" }.into(),
            reduction_db: r(p.noise.reduction.value()),
            sensitivity_db: r(p.noise.sensitivity.value()),
            smoothing: r(p.noise.smoothing.value()),
            from_hz: r(off_hz(p.noise.from_hz.value())),
            resolution: crate::dsp::NOISE_FFT as u32,
            listen_removed: false,
            profile,
        },
        gate: GateJson {
            on: p.gate.on.value(),
            mode: if p.gate.mode.value() == GateModeP::Gate { "gate" } else { "expander" }.into(),
            threshold_db: r(p.gate.threshold.value()),
            hysteresis_db: r(p.gate.hysteresis.value()),
            range_db: r(p.gate.range.value()),
            ratio: r(p.gate.ratio.value()),
            attack_ms: r(p.gate.attack.value()),
            hold_ms: r(p.gate.hold.value()),
            release_ms: r(p.gate.release.value()),
            key_hpf_hz: r(off_hz(p.gate.key_hpf.value())),
            key_lpf_hz: r(off_hz(p.gate.key_lpf.value())),
        },
        eq: EqJson {
            on: p.eq_on.value(),
            bands: p
                .bands
                .iter()
                .map(|b| BandJson { on: b.on.value(), kind: b.kind.value().to_app().into(), freq: b.freq.value().round(), gain_db: r(b.gain.value()), q: r(b.q.value()), slope: b.slope.value().db() })
                .collect(),
        },
        deesser: DeEsserJson {
            on: p.deesser.on.value(),
            freq: p.deesser.freq.value().round(),
            q: r(p.deesser.q.value()),
            threshold_db: r(p.deesser.threshold.value()),
            ratio: r(p.deesser.ratio.value()),
            range_db: r(p.deesser.range.value()),
            mode: if p.deesser.mode.value() == DeEssModeP::Wide { "wide" } else { "split" }.into(),
            listen: false,
        },
        comp1: comp_json(&p.comp1),
        comp2: comp_json(&p.comp2),
        saturation: SatJson {
            on: p.saturation.on.value(),
            mode: match p.saturation.mode.value() {
                SatModeP::Tube => "tube",
                SatModeP::Tape => "tape",
                SatModeP::Amp => "amp",
            }
            .into(),
            drive_db: r(p.saturation.drive.value()),
            tone_hz: p.saturation.tone.value().round(),
            mix: r(p.saturation.mix.value()),
        },
        limiter: LimiterJson { on: p.limiter.on.value(), ceiling_db: r(p.limiter.ceiling.value()), release_ms: r(p.limiter.release.value()) },
    }
}

/// DSP settings straight from an app chain (unity gains, EQ before the compressors)
pub fn settings_of(c: &ChainJson) -> crate::dsp::ChainSettings {
    use crate::dsp::*;
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
    let bands = std::array::from_fn(|i| {
        let b = c.eq.bands.get(i).cloned().unwrap_or_default();
        BandSettings { on: b.on && i < c.eq.bands.len(), kind: BandTypeP::from_app(&b.kind).dsp(), freq: b.freq, gain_db: b.gain_db, q: b.q, slope: b.slope }
    });
    ChainSettings {
        input_gain_db: 0.0,
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
        bands,
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
        output_gain_db: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_has_every_use_with_its_chains() {
        let b = bundle();
        assert!(b.uses.len() >= 20);
        for u in &b.uses {
            for m in &u.mics {
                assert!(b.chains.contains_key(&format!("{}|{}", u.id, m)), "{}|{}", u.id, m);
            }
        }
        let rec = &b.chains["recorded|condenser"];
        assert!(rec.noise.on && rec.deesser.on && rec.comp2.on);
    }

    #[test]
    fn app_preset_files_round_trip() {
        let text = r#"{"app":"gritometro-procesador","version":1,"name":"Mi voz","chain":{"comp1":{"on":true,"ratio":8},"eq":{"on":true,"bands":[{"on":true,"type":"highpass","freq":120,"gainDb":0,"q":0.71,"slope":24}]}}}"#;
        let (name, chain) = parse_preset_file(text).unwrap();
        assert_eq!(name, "Mi voz");
        assert!(chain.comp1.on);
        assert_eq!(chain.comp1.ratio, 8.0);
        // Missing fields take the app defaults
        assert_eq!(chain.comp1.threshold_db, -18.0);
        assert_eq!(chain.eq.bands.len(), 1);
        assert_eq!(chain.limiter.ceiling_db, -1.0);
        let again = parse_preset_file(&serialize_preset_file("x", chain)).unwrap();
        assert_eq!(again.1.eq.bands[0].kind, "highpass");
        assert!(parse_preset_file(r#"{"app":"otra"}"#).is_err());
        assert!(parse_preset_file("nope").is_err());
    }
}
