// The plugin must sound like the app: plugin/tests/parity.json holds the app chain's output
// (TypeScript, src/renderer/src/core/processor/pluginParity.ts) for a test signal; the Rust chain
// has to reproduce it. Regenerate with `npm run plugin:presets` after changing the app's DSP.

use gritometro_procesador::dsp::{lin_to_db, Chain, SAT_LATENCY};
use gritometro_procesador::presets::{bundle, settings_of};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    rate: f32,
    length: usize,
    stride: usize,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    key: String,
    out: Vec<f32>,
}

/// Same formula as paritySignal() in pluginParity.ts
fn signal(len: usize, rate: f64) -> Vec<f32> {
    let mut seed: u32 = 12345;
    (0..len)
        .map(|i| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (seed as f64 / 4294967296.0 - 0.5) * 0.02;
            let t = i as f64 / rate;
            let env = (2.0 * std::f64::consts::PI * 3.0 * t).sin().max(0.0).powi(2);
            (0.4 * env * (2.0 * std::f64::consts::PI * 220.0 * t).sin() + 0.15 * env * (2.0 * std::f64::consts::PI * 6500.0 * t).sin() + noise) as f32
        })
        .collect()
}

#[test]
fn plugin_matches_the_app_chain() {
    let fx: Fixture = serde_json::from_str(include_str!("parity.json")).unwrap();
    let input = signal(fx.length, fx.rate as f64);
    for case in &fx.cases {
        let settings = settings_of(&bundle().chains[&case.key]);
        let mut chain = Chain::new(fx.rate, 1);
        let mut buf = input.clone();
        // A different block size than the app's 128 on purpose: results must not depend on it
        for block in buf.chunks_mut(512) {
            chain.process(&mut [block], &settings);
        }
        let (mut err, mut sig, mut worst) = (0.0f64, 0.0f64, 0.0f32);
        for (k, &expected) in case.out.iter().enumerate() {
            let got = buf[k * fx.stride];
            let d = got - expected;
            err += (d * d) as f64;
            sig += (expected * expected) as f64;
            worst = worst.max(d.abs());
        }
        let snr = 10.0 * (sig / err.max(1e-30)).log10();
        println!("{}: error {:.1} dB below the signal, worst sample {:.2e}", case.key, snr, worst);
        assert!(sig > 1e-3, "{}: the reference is silent", case.key);
        // Float32 vs float64 rounding only: the difference must be inaudible
        assert!(snr > 60.0, "{}: plugin differs from the app ({snr:.1} dB)", case.key);
        assert!(worst < 5e-3, "{}: worst sample differs by {worst}", case.key);
    }
}

#[test]
fn limiter_never_passes_the_ceiling_and_latency_is_constant() {
    let settings = settings_of(&bundle().chains["recorded|condenser"]);
    let mut chain = Chain::new(48000.0, 1);
    let lat = chain.latency();
    assert_eq!(lat, 1024 + SAT_LATENCY + 72 + 5);
    let mut buf: Vec<f32> = (0..48000).map(|i| 2.0 * (i as f32 * 0.05).sin()).collect();
    for block in buf.chunks_mut(256) {
        chain.process(&mut [block], &settings);
    }
    let peak = buf.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    assert!(lin_to_db(peak) <= settings.limiter.ceiling_db + 0.01, "peak {peak}");
}

#[test]
fn noise_reduction_lowers_steady_noise() {
    let mut s = settings_of(&bundle().chains["recorded|condenser"]);
    s.gate.on = false;
    let mut on = Chain::new(48000.0, 1);
    let mut off = Chain::new(48000.0, 1);
    let mut off_s = s;
    off_s.noise.on = false;
    let mut seed: u32 = 1;
    let noise: Vec<f32> = (0..96000)
        .map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed as f32 / 4294967296.0 - 0.5) * 0.05
        })
        .collect();
    let (mut a, mut b) = (noise.clone(), noise);
    for (x, y) in a.chunks_mut(480).zip(b.chunks_mut(480)) {
        on.process(&mut [x], &s);
        off.process(&mut [y], &off_s);
    }
    let rms = |v: &[f32]| (v[48000..].iter().map(|x| x * x).sum::<f32>() / 48000.0).sqrt();
    assert!(lin_to_db(rms(&a)) < lin_to_db(rms(&b)) - 8.0, "{} vs {}", rms(&a), rms(&b));
}

#[test]
fn stereo_dynamics_are_linked_so_the_image_holds() {
    // Loud left, quiet right: both sides must get the same compression and limiting
    let s = settings_of(&bundle().chains["recorded|condenser"]);
    let mut chain = Chain::new(48000.0, 2);
    let tone = |a: f32| -> Vec<f32> { (0..48000).map(|i| a * (i as f32 * 2.0 * std::f32::consts::PI * 300.0 / 48000.0).sin()).collect() };
    let (mut l, mut r) = (tone(0.9), tone(0.1));
    for (a, b) in l.chunks_mut(480).zip(r.chunks_mut(480)) {
        chain.process(&mut [a, b], &s);
    }
    let rms = |v: &[f32]| (v[24000..].iter().map(|x| x * x).sum::<f32>() / 24000.0).sqrt();
    let ratio = lin_to_db(rms(&l)) - lin_to_db(rms(&r));
    // The input difference is 19.1 dB; independent compression would squash it
    assert!((ratio - 19.08).abs() < 0.5, "image moved: L−R {ratio:.2} dB");
}

#[test]
fn automating_the_eq_glides_without_clicks() {
    let mut s = settings_of(&bundle().chains["recorded|condenser"]);
    s.noise.on = false;
    s.gate.on = false;
    let mut chain = Chain::new(48000.0, 1);
    let mut buf: Vec<f32> = (0..48000).map(|i| 0.3 * (i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin()).collect();
    let peaking = s.bands.iter().position(|b| b.on && b.kind == gritometro_procesador::dsp::BandType::Peaking).expect("a peaking band");
    for (k, block) in buf.chunks_mut(256).enumerate() {
        // A jump of +12 dB at 1 kHz in the middle of the signal, as a DAW automation step
        if k == 90 {
            s.bands[peaking].freq = 1000.0;
            s.bands[peaking].gain_db = 12.0;
        }
        chain.process(&mut [block], &s);
    }
    // Second difference relative to the peak: a smooth 1 kHz sine stays at (2π·1000/48000)² ≈ 0.017,
    // a click (a corner in the wave) shows as a spike
    let peak = buf[20000..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
    let bend = buf[20000..].windows(3).fold(0.0f32, |m, w| m.max((w[2] - 2.0 * w[1] + w[0]).abs()));
    assert!(bend / peak < 0.018, "click: {} for peak {peak}", bend / peak);
}
