// Gritómetro Procesador de Audio Android: the plugin's DSP (plugin/src/dsp.rs, itself a port of the
// app's TS processor) compiled for Android and driven from Kotlin through JNI
// (com.gritometro.procesador.audio.Native). The audio thread and the UI share one Engine behind a
// mutex; the UI only holds it to copy values, the heavy work (FFT, YIN) runs on copies.

#[path = "../../../plugin/src/dsp.rs"]
#[allow(dead_code)]
pub mod dsp;

pub mod chain;
pub mod engine;

use engine::{detect_pitch, spectrum_db, Engine, RING};
use jni::objects::{JClass, JFloatArray, JString};
use jni::sys::{jboolean, jfloat, jfloatArray, jint, jlong, jstring, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;
use std::sync::Mutex;

struct Handle {
    engine: Mutex<Engine>,
    io: Mutex<Vec<f32>>,
}

fn handle<'a>(h: jlong) -> Option<&'a Handle> {
    if h == 0 {
        None
    } else {
        // SAFETY: created by Box::into_raw in create(), freed only by destroy()
        Some(unsafe { &*(h as *const Handle) })
    }
}

fn jstr(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|s| s.into()).unwrap_or_default()
}

fn new_floats(env: &mut JNIEnv, v: &[f32]) -> jfloatArray {
    match env.new_float_array(v.len() as i32) {
        Ok(arr) => {
            let _ = env.set_float_array_region(&arr, 0, v);
            arr.into_raw()
        }
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_create(_env: JNIEnv, _c: JClass, sample_rate: jint, channels: jint) -> jlong {
    let ch = (channels as usize).clamp(1, 2);
    let h = Box::new(Handle { engine: Mutex::new(Engine::new(sample_rate as f32, ch)), io: Mutex::new(vec![0.0; engine::MAX_BLOCK * ch]) });
    Box::into_raw(h) as jlong
}

#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_destroy(_env: JNIEnv, _c: JClass, h: jlong) {
    if h != 0 {
        // SAFETY: see handle()
        drop(unsafe { Box::from_raw(h as *mut Handle) });
    }
}

#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_setChain(mut env: JNIEnv, _c: JClass, h: jlong, json: JString, input_gain_db: jfloat, output_gain_db: jfloat, bypass: jboolean) {
    let Some(h) = handle(h) else { return };
    let text = jstr(&mut env, &json);
    let chain = chain::parse_chain(&text);
    if let Ok(mut e) = h.engine.lock() {
        e.set_chain(chain, input_gain_db, output_gain_db, bypass != JNI_FALSE);
    }
}

/// Processes `frames` interleaved frames of `buf` in place
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_process(env: JNIEnv, _c: JClass, h: jlong, buf: JFloatArray, frames: jint) {
    let Some(h) = handle(h) else { return };
    let (Ok(mut e), Ok(mut io)) = (h.engine.lock(), h.io.lock()) else { return };
    let ch = e.channels;
    let mut done = 0usize;
    let frames = frames.max(0) as usize;
    while done < frames {
        let n = (frames - done).min(engine::MAX_BLOCK);
        let slice = &mut io[..n * ch];
        if env.get_float_array_region(&buf, (done * ch) as i32, slice).is_err() {
            return;
        }
        e.process(slice, n);
        let _ = env.set_float_array_region(&buf, (done * ch) as i32, slice);
        done += n;
    }
}

#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_latency(_env: JNIEnv, _c: JClass, h: jlong) -> jint {
    handle(h).and_then(|h| h.engine.lock().ok().map(|e| e.latency() as jint)).unwrap_or(0)
}

/// [inPeak, inRms, outPeak, outRms, noise, gate, deess, comp1, comp2, limiter, LUFS M, LUFS S,
/// true peak, learning (0/1), latency ms]; peaks and reductions held since the last call
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_meters(env: JNIEnv, _c: JClass, h: jlong, out: JFloatArray) {
    let Some(h) = handle(h) else { return };
    let m = match h.engine.lock() {
        Ok(mut e) => e.take_meters(),
        Err(_) => return,
    };
    let _ = env.set_float_array_region(&out, 0, &m);
}

/// Spectrum (dB per bin, RING / 2 bins) of the input (after its gain) or of the output
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_spectrum(env: JNIEnv, _c: JClass, h: jlong, output: jboolean, out: JFloatArray) {
    let Some(h) = handle(h) else { return };
    let mut samples = vec![0f32; RING];
    match h.engine.lock() {
        Ok(e) => e.snapshot(output != JNI_FALSE, &mut samples),
        Err(_) => return,
    }
    let mut bins = vec![0f32; RING / 2];
    spectrum_db(&samples, &mut bins);
    let _ = env.set_float_array_region(&out, 0, &bins);
}

/// [Hz, clarity] of the input, or null when it isn't pitched
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_pitch(mut env: JNIEnv, _c: JClass, h: jlong, min_hz: jfloat, max_hz: jfloat) -> jfloatArray {
    let Some(h) = handle(h) else { return std::ptr::null_mut() };
    let mut samples = vec![0f32; RING];
    let sr = match h.engine.lock() {
        Ok(e) => {
            e.snapshot(false, &mut samples);
            e.sample_rate
        }
        Err(_) => return std::ptr::null_mut(),
    };
    match detect_pitch(&samples, sr, min_hz, max_hz, 0.15) {
        Some((hz, clarity)) => new_floats(&mut env, &[hz, clarity]),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_learnNoise(_env: JNIEnv, _c: JClass, h: jlong, seconds: jfloat) {
    if let Some(Ok(mut e)) = handle(h).map(|h| h.engine.lock()) {
        e.learn_noise(seconds);
    }
}

/// The noise profile captured by learnNoise, once it is finished (null before)
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_takeLearnedProfile(mut env: JNIEnv, _c: JClass, h: jlong) -> jfloatArray {
    let p = match handle(h).map(|h| h.engine.lock()) {
        Some(Ok(mut e)) => e.take_learned(),
        _ => None,
    };
    match p {
        Some(p) => new_floats(&mut env, &p),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_resetLoudness(_env: JNIEnv, _c: JClass, h: jlong) {
    if let Some(Ok(mut e)) = handle(h).map(|h| h.engine.lock()) {
        e.reset_loudness();
    }
}

/// [integrated LUFS, true peak dBTP] since the last resetLoudness
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_loudnessSummary(mut env: JNIEnv, _c: JClass, h: jlong) -> jfloatArray {
    let v = match handle(h).map(|h| h.engine.lock()) {
        Some(Ok(e)) => [e.loudness.integrated(), dsp::lin_to_db(e.true_peak_max)],
        _ => [-100.0, -100.0],
    };
    new_floats(&mut env, &v)
}

/// The chain with every missing field filled in with the app's defaults
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_normalizeChain(mut env: JNIEnv, _c: JClass, json: JString) -> jstring {
    let text = jstr(&mut env, &json);
    env.new_string(chain::normalize_chain(&text)).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// EQ response (dB) of a chain at each frequency
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_eqResponse(mut env: JNIEnv, _c: JClass, json: JString, sample_rate: jfloat, freqs: JFloatArray, out: JFloatArray) {
    let text = jstr(&mut env, &json);
    let c = chain::parse_chain(&text);
    let n = env.get_array_length(&freqs).unwrap_or(0).max(0) as usize;
    let mut f = vec![0f32; n];
    if env.get_float_array_region(&freqs, 0, &mut f).is_err() {
        return;
    }
    let mut r = vec![0f32; n];
    chain::eq_response(&c, sample_rate, &f, &mut r);
    let _ = env.set_float_array_region(&out, 0, &r);
}

/// Static compressor curve: output level (dB) for an input level
#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_compCurve(_env: JNIEnv, _c: JClass, in_db: jfloat, threshold_db: jfloat, ratio: jfloat, knee_db: jfloat) -> jfloat {
    dsp::compressor_curve(in_db, threshold_db, ratio, knee_db)
}

#[no_mangle]
pub extern "system" fn Java_com_gritometro_procesador_audio_Native_isLearning(_env: JNIEnv, _c: JClass, h: jlong) -> jboolean {
    match handle(h).map(|h| h.engine.lock()) {
        Some(Ok(e)) if e.learning() => JNI_TRUE,
        _ => JNI_FALSE,
    }
}
