// Plugin window, drawn like the app's processor panel (src/renderer/src/ui/studio/ProcessorView.tsx
// + processor.css): rack header with presets, vertical meters, signal flow with live reduction,
// big parametric EQ with live spectrum and draggable bands, band strip and module cards with knobs.

use crate::dsp::{band_stages, fft, lookahead_samples, response_db, Coefs, NOISE_FFT};
use crate::params::*;
use crate::presets::{apply_chain, bundle, chain_of, parse_preset_file, serialize_preset_file, ChainJson};
use crate::{Shared, LEARN_SECONDS, SCOPE_SIZE};
use atomic_float::AtomicF32;
use nih_plug::prelude::*;
use nih_plug_egui::create_egui_editor;
use nih_plug_egui::egui::{self, Align2, Color32, CornerRadius, FontId, Pos2, Rect, Sense, Shape, Stroke, StrokeKind, Vec2};
use std::f32::consts::PI;
use std::sync::atomic::Ordering;
use std::sync::Arc;

// ---- Palette (processor.css)

const BG: Color32 = Color32::from_rgb(11, 13, 16);
const PANEL: Color32 = Color32::from_rgb(18, 21, 26);
const PANEL2: Color32 = Color32::from_rgb(23, 27, 33);
const DARK: Color32 = Color32::from_rgb(8, 9, 12);
const OFF: Color32 = Color32::from_rgb(15, 17, 21);
const LINE: Color32 = Color32::from_rgb(35, 40, 49);
const LINE2: Color32 = Color32::from_rgb(46, 52, 64);
const LED_OFF: Color32 = Color32::from_rgb(60, 66, 78);
const TEXT: Color32 = Color32::from_rgb(227, 231, 237);
const DIM: Color32 = Color32::from_rgb(127, 136, 152);
const ACCENT: Color32 = Color32::from_rgb(63, 182, 255);
const OK: Color32 = Color32::from_rgb(74, 222, 128);
const WARN: Color32 = Color32::from_rgb(255, 176, 32);
const BAD: Color32 = Color32::from_rgb(255, 77, 94);

// Module colours (COLORS in ProcessorView.tsx)
const C_NOISE: Color32 = Color32::from_rgb(77, 214, 201);
const C_GATE: Color32 = Color32::from_rgb(94, 224, 138);
const C_EQ: Color32 = Color32::from_rgb(63, 182, 255);
const C_DEESS: Color32 = Color32::from_rgb(180, 140, 255);
const C_COMP1: Color32 = Color32::from_rgb(255, 176, 32);
const C_COMP2: Color32 = Color32::from_rgb(255, 154, 90);
const C_SAT: Color32 = Color32::from_rgb(255, 107, 139);
const C_LIM: Color32 = Color32::from_rgb(255, 77, 94);

const BAND_COLORS: [Color32; 8] = [
    Color32::from_rgb(255, 107, 139),
    Color32::from_rgb(255, 176, 32),
    Color32::from_rgb(255, 224, 102),
    Color32::from_rgb(94, 224, 138),
    Color32::from_rgb(77, 214, 201),
    Color32::from_rgb(63, 182, 255),
    Color32::from_rgb(180, 140, 255),
    Color32::from_rgb(255, 154, 90),
];

const SPEC_COLS: usize = 300;
const EQ_RANGE: f32 = 18.0;

struct GuiState {
    use_id: String,
    mic_id: String,
    msg: String,
    was_learning: bool,
    /// Displayed meters: in, out (dB), then reductions: noise, gate, de-esser, comp 1, comp 2, limiter
    shown: [f32; 8],
    in_hold: (f32, u32),
    out_hold: (f32, u32),
    sel_band: usize,
    drag_band: Option<usize>,
    spec_in: Vec<f32>,
    spec_out: Vec<f32>,
    spec_peak: Vec<f32>,
    samples: Vec<f32>,
    re: Vec<f64>,
    im: Vec<f64>,
}

pub fn create(params: Arc<ProcParams>, shared: Arc<Shared>) -> Option<Box<dyn Editor>> {
    let state = GuiState {
        use_id: "recorded".into(),
        mic_id: "condenser".into(),
        msg: String::new(),
        was_learning: false,
        shown: [-100.0, -100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        in_hold: (-100.0, 0),
        out_hold: (-100.0, 0),
        sel_band: 0,
        drag_band: None,
        spec_in: vec![-140.0; SPEC_COLS + 1],
        spec_out: vec![-140.0; SPEC_COLS + 1],
        spec_peak: vec![-140.0; SPEC_COLS + 1],
        samples: vec![0.0; SCOPE_SIZE],
        re: vec![0.0; SCOPE_SIZE],
        im: vec![0.0; SCOPE_SIZE],
    };
    create_egui_editor(
        params.editor_state.clone(),
        state,
        |ctx, _| {
            let mut v = egui::Visuals::dark();
            v.panel_fill = BG;
            v.window_fill = PANEL;
            v.extreme_bg_color = DARK;
            v.widgets.inactive.bg_fill = PANEL2;
            v.widgets.inactive.weak_bg_fill = PANEL2;
            v.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, LINE2);
            v.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, ACCENT.gamma_multiply(0.6));
            v.selection.bg_fill = ACCENT.gamma_multiply(0.35);
            ctx.set_visuals(v);
            let mut style = (*ctx.style()).clone();
            style.spacing.item_spacing = Vec2::new(8.0, 6.0);
            style.spacing.button_padding = Vec2::new(10.0, 4.0);
            ctx.set_style(style);
        },
        move |ctx, setter, st| {
            ctx.request_repaint();
            let learning = shared.learning.load(Ordering::Relaxed);
            if st.was_learning && !learning {
                set_e(setter, &params.noise.mode, NoiseModeP::Learned);
                st.msg = "Perfil de ruido aprendido.".into();
            }
            st.was_learning = learning;
            read_meters(&shared, st);
            update_spectrum(&shared, st);

            egui::CentralPanel::default().frame(egui::Frame::NONE.fill(BG).inner_margin(12.0)).show(ctx, |ui| {
                egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                    header(ui, &params, &shared);
                    ui.add_space(8.0);
                    preset_bar(ui, setter, &params, &shared, st);
                    if !st.msg.is_empty() {
                        ui.label(egui::RichText::new(&st.msg).size(12.0).color(DIM));
                    }
                    ui.add_space(8.0);
                    main_row(ui, setter, &params, &shared, st);
                    ui.add_space(8.0);
                    bands_strip(ui, setter, &params, st);
                    ui.add_space(8.0);
                    modules(ui, setter, &params, &shared, st);
                });
            });
        },
    )
}

// ---- Shared helpers

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

/// Dark rack panel; `accent` draws the coloured top edge of the module cards
fn panel(ui: &mut egui::Ui, accent: Option<Color32>, body: impl FnOnce(&mut egui::Ui)) {
    let r = egui::Frame::NONE.fill(PANEL).stroke(Stroke::new(1.0_f32, LINE)).corner_radius(5.0).inner_margin(10.0).show(ui, |ui| body(ui)).response;
    if let Some(c) = accent {
        let top = Rect::from_min_size(r.rect.min, Vec2::new(r.rect.width(), 2.0));
        ui.painter().rect_filled(top, CornerRadius { nw: 5, ne: 5, sw: 0, se: 0 }, c);
    }
}

fn small(text: &str) -> egui::RichText {
    egui::RichText::new(text).size(10.5).color(DIM)
}

fn caps(text: &str) -> egui::RichText {
    egui::RichText::new(text.to_uppercase()).size(10.5).strong().color(DIM)
}

fn mono(text: String, color: Color32) -> egui::RichText {
    egui::RichText::new(text).monospace().size(12.0).color(color)
}

fn latency_ms(sr: f32) -> f32 {
    (NOISE_FFT + lookahead_samples(sr)) as f32 / sr * 1000.0
}

// ---- Knob, switch, LED, segmented

/// Rotary knob bound to a parameter: drag up/down (Shift = fine), wheel, double click = default
fn knob<P: Param>(ui: &mut egui::Ui, setter: &ParamSetter, p: &P, label: &str, color: Color32, size: f32, bipolar: bool) {
    let w = (size + 26.0).max(56.0);
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, size + 38.0), Sense::click_and_drag());
    let id = resp.id;
    let norm = p.unmodulated_normalized_value();
    if resp.drag_started() {
        setter.begin_set_parameter(p);
        ui.data_mut(|d| d.insert_temp(id, norm));
    }
    if resp.dragged() {
        let fine = ui.input(|i| i.modifiers.shift);
        let start: f32 = ui.data(|d| d.get_temp(id)).unwrap_or(norm);
        let v = (start - resp.drag_delta().y / if fine { 700.0 } else { 160.0 }).clamp(0.0, 1.0);
        ui.data_mut(|d| d.insert_temp(id, v));
        setter.set_parameter_normalized(p, v);
    }
    if resp.drag_stopped() {
        setter.end_set_parameter(p);
    }
    if resp.double_clicked() {
        setter.begin_set_parameter(p);
        setter.set_parameter_normalized(p, p.default_normalized_value());
        setter.end_set_parameter(p);
    }
    if resp.hovered() {
        let scroll = ui.input(|i| i.smooth_scroll_delta.y);
        if scroll != 0.0 {
            setter.begin_set_parameter(p);
            setter.set_parameter_normalized(p, (norm + scroll / 1200.0).clamp(0.0, 1.0));
            setter.end_set_parameter(p);
        }
    }
    let active = resp.hovered() || resp.dragged();
    let pt = ui.painter_at(rect.expand(2.0));
    pt.text(Pos2::new(rect.center().x, rect.top() + 6.0), Align2::CENTER_CENTER, label.to_uppercase(), FontId::proportional(9.5), DIM);
    let c = Pos2::new(rect.center().x, rect.top() + 16.0 + size / 2.0);
    let r = size / 2.0;
    let angle = |t: f32| 0.75 * PI + t * 1.5 * PI;
    let arc = |t0: f32, t1: f32| -> Vec<Pos2> {
        (0..=32)
            .map(|i| {
                let a = angle(t0 + (t1 - t0) * i as f32 / 32.0);
                Pos2::new(c.x + r * a.cos(), c.y + r * a.sin())
            })
            .collect()
    };
    pt.add(Shape::line(arc(0.0, 1.0), Stroke::new(3.5_f32, LINE)));
    let (a0, a1) = if bipolar { (norm.min(0.5), norm.max(0.5)) } else { (0.0, norm) };
    if a1 - a0 > 0.003 {
        pt.add(Shape::line(arc(a0, a1), Stroke::new(3.5_f32, color)));
    }
    pt.circle_filled(c, r - 6.0, PANEL2);
    pt.circle_stroke(c, r - 6.0, Stroke::new(1.0_f32, if active { color.gamma_multiply(0.7) } else { LINE2 }));
    let a = angle(norm);
    let at = |d: f32| Pos2::new(c.x + d * a.cos(), c.y + d * a.sin());
    pt.line_segment([at((r - 6.0) * 0.3), at(r - 9.0)], Stroke::new(2.0_f32, TEXT));
    pt.text(Pos2::new(rect.center().x, rect.bottom() - 7.0), Align2::CENTER_CENTER, p.normalized_value_to_string(norm, true), FontId::monospace(10.5), if active { color } else { TEXT });
    resp.on_hover_text(format!("{}\nArrastra · rueda · Mayús = fino · doble clic = valor inicial", p.name()));
}

/// ON/OFF pill with a LED, bound to a bool parameter
fn switch(ui: &mut egui::Ui, setter: &ParamSetter, p: &BoolParam, color: Color32, labels: [&str; 2]) {
    let on = p.value();
    let text = if on { labels[0] } else { labels[1] };
    let w = 24.0 + 7.0 * text.chars().count() as f32;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 22.0), Sense::click());
    if resp.clicked() {
        set_b(setter, p, !on);
    }
    let pt = ui.painter();
    pt.rect_filled(rect, 4.0, if on { color.gamma_multiply(0.12) } else { PANEL2 });
    pt.rect_stroke(rect, 4.0, Stroke::new(1.0_f32, if on { color.gamma_multiply(0.6) } else { LINE2 }), StrokeKind::Inside);
    let led = Pos2::new(rect.left() + 10.0, rect.center().y);
    if on {
        pt.circle_filled(led, 6.0, color.gamma_multiply(0.25));
    }
    pt.circle_filled(led, 3.5, if on { color } else { LED_OFF });
    pt.text(Pos2::new(rect.left() + 18.0, rect.center().y), Align2::LEFT_CENTER, text, FontId::monospace(10.5), if on { color } else { DIM });
    resp.on_hover_text(p.name());
}

fn led(ui: &mut egui::Ui, setter: &ParamSetter, p: &BoolParam, color: Color32) {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(14.0), Sense::click());
    if resp.clicked() {
        set_b(setter, p, !p.value());
    }
    let c = rect.center();
    if p.value() {
        ui.painter().circle_filled(c, 7.0, color.gamma_multiply(0.25));
        ui.painter().circle_filled(c, 4.0, color);
    } else {
        ui.painter().circle_filled(c, 4.0, LED_OFF);
    }
    resp.on_hover_text("Activar / desactivar");
}

fn seg_button(ui: &mut egui::Ui, label: &str, sel: bool, color: Color32) -> egui::Response {
    let b = egui::Button::new(egui::RichText::new(label).size(11.5).color(if sel { color } else { DIM }))
        .fill(if sel { color.gamma_multiply(0.12) } else { PANEL2 })
        .stroke(Stroke::new(1.0_f32, if sel { color.gamma_multiply(0.5) } else { LINE2 }))
        .corner_radius(0.0);
    ui.add(b)
}

/// Segmented selector for an enum parameter (like the app's Segmented)
fn segmented<T: Enum + PartialEq + 'static>(ui: &mut egui::Ui, setter: &ParamSetter, p: &EnumParam<T>, color: Color32) {
    let idx = p.value().to_index();
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 0.0;
        for (i, name) in T::variants().iter().enumerate() {
            if seg_button(ui, name, i == idx, color).clicked() && i != idx {
                set_e(setter, p, T::from_index(i));
            }
        }
    });
}

fn combo<T: Enum + PartialEq + Copy + 'static>(ui: &mut egui::Ui, id: &str, setter: &ParamSetter, p: &EnumParam<T>, width: f32) {
    let idx = p.value().to_index();
    let names = T::variants();
    egui::ComboBox::from_id_salt(id).selected_text(egui::RichText::new(names[idx]).size(11.5)).width(width).show_ui(ui, |ui| {
        for (i, name) in names.iter().enumerate() {
            if ui.selectable_label(i == idx, *name).clicked() {
                set_e(setter, p, T::from_index(i));
            }
        }
    });
}

fn gr_badge(ui: &mut egui::Ui, v: f32) {
    let active = v < -0.5;
    egui::Frame::NONE
        .fill(if active { WARN.gamma_multiply(0.12) } else { PANEL2 })
        .stroke(Stroke::new(1.0_f32, if active { WARN.gamma_multiply(0.5) } else { LINE2 }))
        .corner_radius(3.0)
        .inner_margin(egui::Margin::symmetric(6, 2))
        .show(ui, |ui| ui.label(mono(format!("GR {:.1} dB", v.min(0.0)), if active { WARN } else { DIM })));
}

// ---- Header and presets

fn header(ui: &mut egui::Ui, p: &ProcParams, sh: &Shared) {
    panel(ui, None, |ui| {
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.label(egui::RichText::new("PROCESADOR").size(17.0).strong().color(TEXT));
                ui.label(small("Reducción de ruido · puerta · EQ paramétrico · de-esser · compresión · saturación · limitador"));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let sr = sh.sample_rate.load(Ordering::Relaxed);
                readout(ui, "Latencia", format!("{:.1} ms", latency_ms(sr)));
                readout(ui, "Muestreo", format!("{:.1} kHz", sr / 1000.0));
                let name = p.preset_name.read().map(|n| n.clone()).unwrap_or_default();
                if !name.is_empty() {
                    readout(ui, "Preset", name);
                }
                ui.label(egui::RichText::new("● EN LÍNEA").monospace().size(11.5).color(OK));
            });
        });
    });
}

/// Small dark box with a caption and a monospace value, sized to its text
fn readout(ui: &mut egui::Ui, label: &str, value: String) {
    let font = FontId::monospace(12.5);
    let value_w = ui.fonts(|f| f.layout_no_wrap(value.clone(), font.clone(), TEXT).size().x);
    let w = value_w.max(label.len() as f32 * 6.0) + 18.0;
    let (rect, _) = ui.allocate_exact_size(Vec2::new(w, 36.0), Sense::hover());
    let pt = ui.painter();
    pt.rect_filled(rect, 3.0, DARK);
    pt.rect_stroke(rect, 3.0, Stroke::new(1.0_f32, LINE), StrokeKind::Inside);
    pt.text(Pos2::new(rect.left() + 9.0, rect.top() + 10.0), Align2::LEFT_CENTER, label.to_uppercase(), FontId::proportional(9.5), DIM);
    pt.text(Pos2::new(rect.left() + 9.0, rect.top() + 25.0), Align2::LEFT_CENTER, value, font, TEXT);
}

fn preset_bar(ui: &mut egui::Ui, setter: &ParamSetter, params: &ProcParams, shared: &Shared, st: &mut GuiState) {
    let b = bundle();
    panel(ui, None, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.vertical(|ui| {
                ui.label(caps("Uso"));
                let use_name = b.uses.iter().find(|u| u.id == st.use_id).map(|u| u.name.as_str()).unwrap_or("—");
                egui::ComboBox::from_id_salt("use").selected_text(use_name).width(260.0).show_ui(ui, |ui| {
                    for (gid, glabel) in &b.groups {
                        ui.label(caps(glabel));
                        for u in b.uses.iter().filter(|u| &u.group == gid) {
                            if ui.selectable_label(u.id == st.use_id, format!("  {}", u.name)).on_hover_text(&u.hint).clicked() {
                                let was_voice = b.uses.iter().find(|x| x.id == st.use_id).map(|x| x.group == "voice");
                                // Crossing voice ↔ instrument (or a mic that doesn't fit) picks the usual capture
                                if !u.mics.contains(&st.mic_id) || was_voice != Some(u.group == "voice") {
                                    st.mic_id = u.default_mic.clone();
                                }
                                st.use_id = u.id.clone();
                            }
                        }
                    }
                });
            });
            let Some(u) = b.uses.iter().find(|u| u.id == st.use_id) else { return };
            let mic_name = b.mics.iter().find(|m| m.id == st.mic_id).map(|m| m.name.clone()).unwrap_or_default();
            ui.vertical(|ui| {
                ui.label(caps(if u.group == "voice" { "Tipo de micrófono" } else { "Micrófono o pastilla" }));
                egui::ComboBox::from_id_salt("mic").selected_text(&mic_name).width(260.0).show_ui(ui, |ui| {
                    for (gid, glabel) in &b.mic_groups {
                        let list: Vec<_> = b.mics.iter().filter(|m| &m.group == gid && u.mics.contains(&m.id)).collect();
                        if list.is_empty() {
                            continue;
                        }
                        ui.label(caps(glabel));
                        for m in list {
                            if ui.selectable_label(m.id == st.mic_id, format!("  {}", m.name)).on_hover_text(&m.hint).clicked() {
                                st.mic_id = m.id.clone();
                            }
                        }
                    }
                });
            });
            ui.vertical(|ui| {
                ui.label(" ");
                let apply = egui::Button::new(egui::RichText::new("Aplicar preset").strong().color(Color32::from_rgb(4, 20, 32))).fill(ACCENT).corner_radius(4.0);
                if ui.add(apply).on_hover_text(&u.hint).clicked() {
                    if let Some(chain) = b.chains.get(&format!("{}|{}", st.use_id, st.mic_id)) {
                        apply_chain(setter, params, chain);
                        let name = format!("{} · {}", u.name, mic_name);
                        if let Ok(mut n) = params.preset_name.write() {
                            *n = name.clone();
                        }
                        st.msg = format!("Preset aplicado: {name}");
                    }
                }
            });
            ui.add_space(16.0);
            ui.vertical(|ui| {
                ui.label(caps("Mis presets"));
                ui.horizontal(|ui| {
                    if ui.button("Cargar…").on_hover_text("Abre un preset .json guardado desde la app o desde este plugin").clicked() {
                        load_preset(setter, params, shared, st);
                    }
                    if ui.button("Guardar…").on_hover_text("Guarda la cadena actual en un .json que también abre la app").clicked() {
                        save_preset(params, st);
                    }
                    if ui.button("Restablecer").on_hover_text("Vuelve todo el procesamiento a los valores iniciales").clicked() {
                        apply_chain(setter, params, &ChainJson::default());
                        if let Ok(mut n) = params.preset_name.write() {
                            n.clear();
                        }
                        st.msg = "Procesamiento restablecido.".into();
                    }
                });
            });
        });
    });
}

fn load_preset(setter: &ParamSetter, params: &ProcParams, shared: &Shared, st: &mut GuiState) {
    let Some(path) = rfd::FileDialog::new().add_filter("Preset del procesador", &["json"]).pick_file() else { return };
    match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| parse_preset_file(&t)) {
        Ok((name, chain)) => {
            if let Some(profile) = apply_chain(setter, params, &chain) {
                if let Ok(mut p) = params.noise_profile.write() {
                    *p = profile;
                }
                shared.profile_dirty.store(true, Ordering::Relaxed);
            }
            if let Ok(mut n) = params.preset_name.write() {
                *n = name.clone();
            }
            st.msg = format!("Preset «{name}» cargado.");
        }
        Err(e) => st.msg = e,
    }
}

fn save_preset(params: &ProcParams, st: &mut GuiState) {
    let current = params.preset_name.read().map(|n| n.clone()).unwrap_or_default();
    let suggested = if current.is_empty() { "procesador".to_string() } else { current.replace(['·', '/', '\\', ':'], "-") };
    let Some(path) = rfd::FileDialog::new().add_filter("Preset del procesador", &["json"]).set_file_name(format!("{suggested}.json")).save_file() else { return };
    let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(suggested);
    match std::fs::write(&path, serialize_preset_file(&name, chain_of(params))) {
        Ok(()) => {
            if let Ok(mut n) = params.preset_name.write() {
                *n = name;
            }
            st.msg = format!("Preset guardado en {}", path.display());
        }
        Err(e) => st.msg = format!("No se pudo guardar: {e}"),
    }
}

// ---- Meters and spectrum

fn read_meters(sh: &Shared, st: &mut GuiState) {
    let take = |a: &AtomicF32, reset: f32| a.swap(reset, Ordering::Relaxed);
    let vals = [
        take(&sh.in_peak, -100.0),
        take(&sh.out_peak, -100.0),
        take(&sh.noise_db, 0.0),
        take(&sh.gate_db, 0.0),
        take(&sh.deess_gr, 0.0),
        take(&sh.comp1_gr, 0.0),
        take(&sh.comp2_gr, 0.0),
        take(&sh.lim_gr, 0.0),
    ];
    for (i, v) in vals.iter().enumerate() {
        let s = &mut st.shown[i];
        if i < 2 {
            // Levels: instant rise, ~20 dB/s fall at 60 fps
            *s = if *v > *s { *v } else { (*s - 0.35).max(*v).max(-100.0) };
        } else {
            *s = if *v < *s { *v } else { (*s + 0.35).min(0.0) };
        }
    }
    for (hold, v) in [(&mut st.in_hold, st.shown[0]), (&mut st.out_hold, st.shown[1])] {
        if v >= hold.0 || hold.1 == 0 {
            *hold = (v, 90);
        } else {
            hold.1 -= 1;
        }
    }
}

/// FFT of the latest samples, folded into log-spaced columns (20 Hz … 20 kHz)
fn update_spectrum(sh: &Shared, st: &mut GuiState) {
    let sr = sh.sample_rate.load(Ordering::Relaxed) as f64;
    let n = SCOPE_SIZE;
    let bin_hz = sr / n as f64;
    // A Hann-windowed full-scale sine peaks at ≈ n/4
    let reference = (n as f64 / 4.0).powi(2);
    for which in 0..2 {
        let scope = if which == 0 { &sh.scope_in } else { &sh.scope_out };
        match scope.lock() {
            Ok(s) => s.ordered(&mut st.samples),
            Err(_) => continue,
        }
        for i in 0..n {
            let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
            st.re[i] = st.samples[i] as f64 * w;
            st.im[i] = 0.0;
        }
        fft(&mut st.re, &mut st.im);
        for k in 0..=SPEC_COLS {
            let f0 = 20.0 * 1000f64.powf(k as f64 / SPEC_COLS as f64);
            let f1 = 20.0 * 1000f64.powf((k + 1) as f64 / SPEC_COLS as f64);
            let b0 = ((f0 / bin_hz).floor() as usize).clamp(1, n / 2 - 1);
            let b1 = ((f1 / bin_hz).ceil() as usize).clamp(b0, n / 2 - 1);
            let m = (b0..=b1).map(|b| st.re[b] * st.re[b] + st.im[b] * st.im[b]).fold(0.0f64, f64::max);
            let db = (10.0 * (m / reference + 1e-20).log10()) as f32;
            let col = if which == 0 { &mut st.spec_in[k] } else { &mut st.spec_out[k] };
            // Fast rise, slower fall, like the analysers in the app
            *col = if db > *col { *col * 0.4 + db * 0.6 } else { *col * 0.8 + db * 0.2 };
            if which == 1 {
                st.spec_peak[k] = (st.spec_peak[k] - 0.25).max(*col);
            }
        }
    }
}

fn vmeter(ui: &mut egui::Ui, db: f32, hold: f32, label: &str) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(64.0, 250.0), Sense::hover());
    let p = ui.painter_at(rect);
    let bar = Rect::from_min_max(Pos2::new(rect.right() - 26.0, rect.top() + 14.0), Pos2::new(rect.right() - 8.0, rect.bottom() - 16.0));
    let y_of = |d: f32| bar.bottom() - ((d + 60.0) / 60.0).clamp(0.0, 1.0) * bar.height();
    p.rect_filled(bar, 2.0, DARK);
    p.rect_stroke(bar, 2.0, Stroke::new(1.0_f32, LINE), StrokeKind::Outside);
    for d in [0.0f32, -6.0, -12.0, -18.0, -24.0, -36.0, -48.0, -60.0] {
        let y = y_of(d);
        p.line_segment([Pos2::new(bar.left() - 4.0, y), Pos2::new(bar.left() - 1.0, y)], Stroke::new(1.0_f32, LINE2));
        p.text(Pos2::new(bar.left() - 6.0, y), Align2::RIGHT_CENTER, format!("{d:.0}"), FontId::monospace(9.0), DIM);
    }
    // Segments: green up to −12, amber to −3, red above
    let top = y_of(db.max(-60.0));
    let mut y = bar.bottom() - 1.0;
    while y - 3.0 >= top {
        let d = -60.0 + (bar.bottom() - (y - 1.5)) / bar.height() * 60.0;
        let c = if d > -3.0 { BAD } else if d > -12.0 { WARN } else { OK };
        p.rect_filled(Rect::from_min_max(Pos2::new(bar.left() + 2.0, y - 3.0), Pos2::new(bar.right() - 2.0, y)), 0.0, c);
        y -= 4.0;
    }
    if hold > -59.0 {
        let hy = y_of(hold);
        p.line_segment([Pos2::new(bar.left() + 1.0, hy), Pos2::new(bar.right() - 1.0, hy)], Stroke::new(2.0_f32, TEXT));
    }
    p.text(Pos2::new(bar.center().x, rect.top() + 5.0), Align2::CENTER_CENTER, "CLIP", FontId::monospace(9.0), if hold > -0.5 { BAD } else { LINE2 });
    p.text(Pos2::new(bar.center().x, rect.bottom() - 6.0), Align2::CENTER_CENTER, label, FontId::monospace(10.0), DIM);
}

fn side_column(ui: &mut egui::Ui, title: &str, label: &str, level: f32, hold: f32, body: impl FnOnce(&mut egui::Ui)) {
    panel(ui, None, |ui| {
        ui.set_width(84.0);
        ui.vertical_centered(|ui| {
            ui.label(caps(title));
            vmeter(ui, level, hold, label);
            ui.label(small("Pico"));
            ui.label(mono(if hold <= -99.0 { "—".into() } else { format!("{hold:.1}") }, TEXT));
            body(ui);
        });
    });
}

fn main_row(ui: &mut egui::Ui, setter: &ParamSetter, p: &ProcParams, sh: &Shared, st: &mut GuiState) {
    ui.horizontal_top(|ui| {
        side_column(ui, "Entrada", "IN", st.shown[0], st.in_hold.0, |ui| {
            knob(ui, setter, &p.input_gain, "Ganancia", ACCENT, 40.0, true);
            switch(ui, setter, &p.phase_invert, ACCENT, ["Ø", "Ø"]);
        });
        // Two side columns of 84 px + frame (22 px) each, plus the spacing between the three
        let center_w = ui.available_width() - 2.0 * (84.0 + 22.0) - 2.0 * ui.spacing().item_spacing.x;
        ui.vertical(|ui| {
            ui.set_width(center_w);
            signal_flow(ui, setter, p, st);
            ui.add_space(6.0);
            panel(ui, None, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Ecualizador").strong().color(TEXT));
                    switch(ui, setter, &p.eq_on, C_EQ, ["ON", "OFF"]);
                    ui.add_space(8.0);
                    let post = p.eq_post.value();
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 0.0;
                        for (label, v) in [("EQ > Comp", false), ("Comp > EQ", true)] {
                            if seg_button(ui, label, post == v, C_EQ).on_hover_text("Ecualizar antes de comprimir (clásico) o después").clicked() && post != v {
                                set_b(setter, &p.eq_post, v);
                            }
                        }
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button(egui::RichText::new("Ganancias a 0").size(11.5)).clicked() {
                            for b in &p.bands {
                                set_f(setter, &b.gain, 0.0);
                            }
                        }
                    });
                });
                eq_graph(ui, setter, p, sh.sample_rate.load(Ordering::Relaxed), st);
                ui.horizontal(|ui| {
                    ui.label(small("Arrastra los puntos · rueda = ancho (Q) · clic derecho = activar/desactivar"));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        legend(ui, "Pico", Color32::from_rgb(255, 224, 102));
                        legend(ui, "Salida", ACCENT);
                        legend(ui, "Entrada", Color32::from_rgb(138, 147, 163));
                    });
                });
            });
        });
        side_column(ui, "Salida", "OUT", st.shown[1], st.out_hold.0, |ui| {
            knob(ui, setter, &p.output_gain, "Salida", ACCENT, 40.0, true);
        });
    });
}

fn legend(ui: &mut egui::Ui, label: &str, color: Color32) {
    ui.label(egui::RichText::new(label).size(10.5).color(color));
    let (r, _) = ui.allocate_exact_size(Vec2::new(14.0, 3.0), Sense::hover());
    ui.painter().rect_filled(r, 1.0, color);
}

// ---- Signal flow: one block per stage with its LED and live reduction

fn signal_flow(ui: &mut egui::Ui, setter: &ParamSetter, p: &ProcParams, st: &GuiState) {
    let s = &st.shown;
    let db = |v: f32| format!("{:.1} dB", v.min(0.0));
    let gate_title = if p.gate.mode.value() == GateModeP::Gate { "Puerta" } else { "Expansor" };
    let eq_n = p.bands.iter().filter(|b| b.on.value()).count();
    let mut blocks: Vec<(&str, &BoolParam, Color32, String, f32)> = vec![("Ruido", &p.noise.on, C_NOISE, db(s[2]), s[2]), (gate_title, &p.gate.on, C_GATE, db(s[3]), s[3])];
    let eq = ("EQ", &p.eq_on, C_EQ, format!("{eq_n} bandas"), 0.0);
    let sat_value = if p.saturation.on.value() { format!("{:.1} dB", p.saturation.drive.value()) } else { "—".into() };
    let dynamics = [
        ("De-esser", &p.deesser.on, C_DEESS, db(s[4]), s[4]),
        ("Comp 1", &p.comp1.on, C_COMP1, db(s[5]), s[5]),
        ("Comp 2", &p.comp2.on, C_COMP2, db(s[6]), s[6]),
        ("Saturador", &p.saturation.on, C_SAT, sat_value, 0.0),
    ];
    if p.eq_post.value() {
        blocks.extend(dynamics);
        blocks.push(eq);
    } else {
        blocks.push(eq);
        blocks.extend(dynamics);
    }
    blocks.push(("Limitador", &p.limiter.on, C_LIM, db(s[7]), s[7]));
    panel(ui, None, |ui| {
        let gap = 6.0;
        let w = (ui.available_width() - gap * (blocks.len() as f32 - 1.0)) / blocks.len() as f32;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = gap;
            for (title, on_p, color, value, gr) in blocks {
                let on = on_p.value();
                let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 54.0), Sense::click());
                let pt = ui.painter();
                pt.rect_filled(rect, 4.0, if on { PANEL2 } else { OFF });
                pt.rect_stroke(rect, 4.0, Stroke::new(1.0_f32, if on { color.gamma_multiply(0.45) } else { LINE }), StrokeKind::Inside);
                pt.rect_filled(Rect::from_min_size(rect.min, Vec2::new(rect.width(), 2.0)), CornerRadius { nw: 4, ne: 4, sw: 0, se: 0 }, if on { color } else { LINE2 });
                let led_c = Pos2::new(rect.left() + 12.0, rect.top() + 15.0);
                if on {
                    pt.circle_filled(led_c, 6.5, color.gamma_multiply(0.25));
                }
                pt.circle_filled(led_c, 3.5, if on { color } else { LED_OFF });
                pt.text(Pos2::new(rect.left() + 22.0, rect.top() + 15.0), Align2::LEFT_CENTER, title, FontId::proportional(12.0), if on { TEXT } else { DIM });
                let bar = Rect::from_min_size(Pos2::new(rect.left() + 8.0, rect.top() + 28.0), Vec2::new(rect.width() - 16.0, 3.0));
                pt.rect_filled(bar, 1.0, DARK);
                let t = (-gr / 24.0).clamp(0.0, 1.0);
                if t > 0.0 {
                    pt.rect_filled(Rect::from_min_size(bar.min, Vec2::new(bar.width() * t, bar.height())), 1.0, color);
                }
                pt.text(Pos2::new(rect.left() + 8.0, rect.bottom() - 11.0), Align2::LEFT_CENTER, value, FontId::monospace(10.5), DIM);
                if resp.clicked() {
                    set_b(setter, on_p, !on);
                }
                resp.on_hover_text("Clic = activar / desactivar");
            }
        });
    });
}

// ---- Parametric EQ graph

fn eq_graph(ui: &mut egui::Ui, setter: &ParamSetter, p: &ProcParams, sr: f32, st: &mut GuiState) {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 270.0), Sense::click_and_drag());
    let pt = ui.painter_at(rect);
    pt.rect_filled(rect, 4.0, Color32::from_rgb(9, 11, 14));
    let x_of = |f: f32| rect.left() + (f.max(20.0) / 20.0).log10() / 3.0 * rect.width();
    let f_of = |x: f32| 20.0 * 1000f32.powf(((x - rect.left()) / rect.width()).clamp(0.0, 1.0));
    let y_of = |db: f32| rect.center().y - (db.clamp(-EQ_RANGE * 1.4, EQ_RANGE * 1.4) / EQ_RANGE) * rect.height() / 2.0;
    let db_of = |y: f32| (rect.center().y - y) / (rect.height() / 2.0) * EQ_RANGE;

    // Live spectrum behind the curve: −100 … −10 dBFS fills the height
    let ys = |db: f32| rect.bottom() - ((db + 100.0) / 90.0).clamp(0.0, 1.0) * rect.height();
    let xs = |k: usize| rect.left() + k as f32 / SPEC_COLS as f32 * rect.width();
    for (cols, fill, stroke) in [
        (&st.spec_in, Color32::from_rgba_unmultiplied(138, 147, 163, 20), Color32::from_rgba_unmultiplied(138, 147, 163, 100)),
        (&st.spec_out, Color32::from_rgba_unmultiplied(63, 182, 255, 28), Color32::from_rgba_unmultiplied(63, 182, 255, 170)),
    ] {
        for k in 0..SPEC_COLS {
            pt.rect_filled(Rect::from_min_max(Pos2::new(xs(k), ys(cols[k])), Pos2::new(xs(k + 1) + 0.5, rect.bottom())), 0.0, fill);
        }
        pt.add(Shape::line((0..=SPEC_COLS).map(|k| Pos2::new(xs(k), ys(cols[k]))).collect(), Stroke::new(1.0_f32, stroke)));
    }
    pt.add(Shape::line((0..=SPEC_COLS).map(|k| Pos2::new(xs(k), ys(st.spec_peak[k]))).collect(), Stroke::new(1.0_f32, Color32::from_rgba_unmultiplied(255, 224, 102, 120))));

    let grid = Stroke::new(1.0_f32, Color32::from_rgb(29, 34, 41));
    for f in [30.0f32, 50.0, 100.0, 200.0, 300.0, 500.0, 1000.0, 2000.0, 3000.0, 5000.0, 10000.0, 15000.0] {
        let major = f == 100.0 || f == 1000.0 || f == 10000.0;
        pt.line_segment([Pos2::new(x_of(f), rect.top()), Pos2::new(x_of(f), rect.bottom())], if major { Stroke::new(1.0_f32, LINE2) } else { grid });
        let t = if f >= 1000.0 { format!("{}k", f / 1000.0) } else { format!("{f}") };
        pt.text(Pos2::new(x_of(f) + 3.0, rect.bottom() - 4.0), Align2::LEFT_BOTTOM, t, FontId::monospace(9.5), DIM);
    }
    for d in [-18.0f32, -12.0, -6.0, 0.0, 6.0, 12.0, 18.0] {
        let y = y_of(d);
        pt.line_segment([Pos2::new(rect.left(), y), Pos2::new(rect.right(), y)], if d == 0.0 { Stroke::new(1.0_f32, Color32::from_rgb(70, 78, 92)) } else { grid });
        pt.text(Pos2::new(rect.left() + 4.0, y - 2.0), Align2::LEFT_BOTTOM, if d > 0.0 { format!("+{d}") } else { format!("{d}") }, FontId::monospace(9.5), DIM);
    }

    let bands = p.band_settings();
    let on = p.eq_on.value();
    let freqs: Vec<f32> = (0..=300).map(|i| 20.0 * 1000f32.powf(i as f32 / 300.0)).collect();
    // The selected band's own contribution, filled
    let sec: Vec<Coefs> = band_stages(&bands[st.sel_band], on, sr).to_vec();
    let sel_pts: Vec<Pos2> = freqs.iter().map(|&f| Pos2::new(x_of(f), y_of(response_db(&sec, f as f64, sr as f64) as f32))).collect();
    let zero = y_of(0.0);
    let sel_fill = BAND_COLORS[st.sel_band].gamma_multiply(0.14);
    for w in sel_pts.windows(2) {
        if (w[0].y - zero).abs() > 0.3 || (w[1].y - zero).abs() > 0.3 {
            pt.add(Shape::convex_polygon(vec![w[0], w[1], Pos2::new(w[1].x, zero), Pos2::new(w[0].x, zero)], sel_fill, Stroke::NONE));
        }
    }
    let sections: Vec<Coefs> = bands.iter().flat_map(|b| band_stages(b, on, sr)).collect();
    let curve: Vec<Pos2> = freqs.iter().map(|&f| Pos2::new(x_of(f), y_of(response_db(&sections, f as f64, sr as f64) as f32))).collect();
    pt.add(Shape::line(curve, Stroke::new(2.2_f32, if on { ACCENT } else { DIM })));

    let handle = |i: usize| {
        let b = &bands[i];
        Pos2::new(x_of(b.freq.clamp(20.0, 20000.0)), y_of(if b.kind.has_gain() && on && b.on { b.gain_db } else { 0.0 }))
    };
    let nearest = |pos: Pos2| (0..bands.len()).map(|i| (i, handle(i).distance(pos))).filter(|(_, d)| *d < 16.0).min_by(|a, b| a.1.total_cmp(&b.1)).map(|(i, _)| i);

    if resp.drag_started() {
        if let Some(i) = resp.interact_pointer_pos().and_then(nearest) {
            st.drag_band = Some(i);
            st.sel_band = i;
            setter.begin_set_parameter(&p.bands[i].freq);
            setter.begin_set_parameter(&p.bands[i].gain);
        }
    }
    if resp.dragged() {
        if let (Some(i), Some(pos)) = (st.drag_band, resp.interact_pointer_pos()) {
            setter.set_parameter(&p.bands[i].freq, f_of(pos.x).round());
            if bands[i].kind.has_gain() {
                setter.set_parameter(&p.bands[i].gain, (db_of(pos.y).clamp(-EQ_RANGE, EQ_RANGE) * 2.0).round() / 2.0);
            }
        }
    }
    if resp.drag_stopped() {
        if let Some(i) = st.drag_band.take() {
            setter.end_set_parameter(&p.bands[i].freq);
            setter.end_set_parameter(&p.bands[i].gain);
        }
    }
    if resp.clicked() {
        if let Some(i) = resp.interact_pointer_pos().and_then(nearest) {
            st.sel_band = i;
        }
    }
    if resp.secondary_clicked() {
        if let Some(i) = resp.interact_pointer_pos().and_then(nearest) {
            set_b(setter, &p.bands[i].on, !p.bands[i].on.value());
        }
    }
    if resp.hovered() {
        let scroll = ui.input(|i| i.smooth_scroll_delta.y);
        let b = &p.bands[st.sel_band];
        if scroll != 0.0 && b.kind.value().dsp().has_q() {
            let q = (b.q.value() * if scroll > 0.0 { 1.06 } else { 1.0 / 1.06 }).clamp(0.1, 20.0);
            set_f(setter, &b.q, (q * 100.0).round() / 100.0);
        }
    }

    for (i, b) in bands.iter().enumerate() {
        let c = handle(i);
        let col = BAND_COLORS[i];
        let sel = i == st.sel_band;
        if b.on {
            if sel {
                pt.circle_filled(c, 15.0, col.gamma_multiply(0.18));
            }
            pt.circle_filled(c, 10.0, col.gamma_multiply(0.9));
            pt.circle_stroke(c, 10.0, Stroke::new(if sel { 2.0_f32 } else { 1.0_f32 }, if sel { Color32::WHITE } else { DARK }));
            pt.text(c, Align2::CENTER_CENTER, format!("{}", i + 1), FontId::proportional(10.5), DARK);
        } else {
            pt.circle_stroke(c, 9.0, Stroke::new(1.5_f32, col.gamma_multiply(0.5)));
            pt.text(c, Align2::CENTER_CENTER, format!("{}", i + 1), FontId::proportional(10.0), col.gamma_multiply(0.6));
        }
    }
    pt.rect_stroke(rect, 4.0, Stroke::new(1.0_f32, LINE), StrokeKind::Inside);
}

// ---- Band strip

fn bands_strip(ui: &mut egui::Ui, setter: &ParamSetter, p: &ProcParams, st: &mut GuiState) {
    let eq_on = p.eq_on.value();
    panel(ui, None, |ui| {
        ui.columns(8, |cols| {
            for ((i, b), ui) in p.bands.iter().enumerate().zip(cols.iter_mut()) {
                let w = ui.available_width();
                let col = BAND_COLORS[i];
                let sel = i == st.sel_band;
                let kind = b.kind.value().dsp();
                let resp = egui::Frame::NONE
                    .fill(if sel { PANEL2 } else { OFF })
                    .stroke(Stroke::new(1.0_f32, if sel { col.gamma_multiply(0.7) } else { LINE }))
                    .corner_radius(4.0)
                    .inner_margin(6.0)
                    .show(ui, |ui| {
                        ui.set_width(w - 14.0);
                        if !(eq_on && b.on.value()) {
                            ui.multiply_opacity(0.55);
                        }
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 4.0;
                            led(ui, setter, &b.on, col);
                            ui.label(egui::RichText::new(format!("{}", i + 1)).strong().color(col));
                            combo(ui, &format!("b{i}t"), setter, &b.kind, (w - 70.0).max(56.0));
                        });
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 0.0;
                            knob(ui, setter, &b.freq, "Frec.", col, 32.0, false);
                            if kind.has_gain() {
                                knob(ui, setter, &b.gain, "Gan.", col, 32.0, true);
                            }
                        });
                        if kind.has_q() {
                            knob(ui, setter, &b.q, if kind.has_slope() { "Res." } else { "Q" }, col, 32.0, false);
                        }
                        if kind.has_slope() {
                            combo(ui, &format!("b{i}s"), setter, &b.slope, (w - 40.0).max(56.0));
                        }
                    })
                    .response;
                if resp.interact(Sense::click()).clicked() {
                    st.sel_band = i;
                }
            }
        });
    });
}

// ---- Module cards

fn module_card(ui: &mut egui::Ui, width: f32, title: &str, color: Color32, setter: &ParamSetter, on: &BoolParam, gr: Option<f32>, actions: impl FnOnce(&mut egui::Ui), knobs: impl FnOnce(&mut egui::Ui)) {
    let active = on.value();
    panel(ui, Some(if active { color } else { LINE2 }), |ui| {
        ui.set_min_width(width - 22.0);
        ui.set_max_width(width - 22.0);
        ui.horizontal(|ui| {
            switch(ui, setter, on, color, ["ON", "OFF"]);
            ui.label(egui::RichText::new(title).strong().size(13.0).color(if active { TEXT } else { DIM }));
            if let Some(v) = gr {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| gr_badge(ui, v));
            }
        });
        ui.horizontal_wrapped(|ui| actions(ui));
        ui.add_space(2.0);
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = Vec2::new(2.0, 4.0);
            if !active {
                ui.multiply_opacity(0.6);
            }
            knobs(ui)
        });
    });
    ui.add_space(8.0);
}

fn modules(ui: &mut egui::Ui, setter: &ParamSetter, p: &ProcParams, sh: &Shared, st: &mut GuiState) {
    let s = st.shown;
    let k = 42.0;
    // Fixed column widths from the window (minus margins and scrollbar), so nothing can widen them
    let gap = 8.0;
    let total = ui.available_width().min(ui.ctx().screen_rect().width() - 40.0);
    let w = ((total - gap * 2.0) / 3.0).floor();
    let column = |ui: &mut egui::Ui, body: &mut dyn FnMut(&mut egui::Ui)| {
        ui.allocate_ui_with_layout(Vec2::new(w, 0.0), egui::Layout::top_down(egui::Align::Min), |ui| {
            ui.set_max_width(w);
            body(ui)
        });
    };
    ui.horizontal_top(|ui| {
        ui.spacing_mut().item_spacing.x = gap;
        // Column 1: noise reduction and gate
        column(ui, &mut |ui| {
            let n = &p.noise;
            module_card(
                ui,
                w,
                "Reducción de ruido",
                C_NOISE,
                setter,
                &n.on,
                Some(s[2]),
                |ui| {
                    segmented(ui, setter, &n.mode, C_NOISE);
                    let learning = sh.learning.load(Ordering::Relaxed);
                    let label = if learning { "Aprendiendo…" } else { "Aprender" };
                    let hint = format!("Reproduce un tramo sin voz (solo el ruido de la sala) y pulsa: captura {LEARN_SECONDS:.0} s de ruido");
                    if ui.add_enabled(!learning, egui::Button::new(egui::RichText::new(label).size(11.5).color(if learning { BAD } else { TEXT }))).on_hover_text(hint).clicked() {
                        sh.learn_request.store(true, Ordering::Relaxed);
                        st.msg = "Aprendiendo el ruido: reproduce un tramo en silencio…".into();
                    }
                    let has = p.noise_profile.read().map(|v| !v.is_empty()).unwrap_or(false);
                    ui.label(small(if has { "Perfil guardado" } else { "Sin perfil" }));
                    if has && ui.button(egui::RichText::new("Borrar perfil").size(11.5)).clicked() {
                        if let Ok(mut v) = p.noise_profile.write() {
                            v.clear();
                        }
                        sh.profile_dirty.store(true, Ordering::Relaxed);
                        set_e(setter, &n.mode, NoiseModeP::Adaptive);
                    }
                    switch(ui, setter, &n.listen_removed, C_NOISE, ["ELIMINADO", "ELIMINADO"]);
                },
                |ui| {
                    knob(ui, setter, &n.reduction, "Reducción", C_NOISE, k, false);
                    knob(ui, setter, &n.sensitivity, "Sensibilidad", C_NOISE, k, true);
                    knob(ui, setter, &n.smoothing, "Suavizado", C_NOISE, k, false);
                    knob(ui, setter, &n.from_hz, "Desde", C_NOISE, k, false);
                },
            );
            let g = &p.gate;
            module_card(ui, w, "Puerta de ruido / expansor", C_GATE, setter, &g.on, Some(s[3]), |ui| segmented(ui, setter, &g.mode, C_GATE), |ui| {
                knob(ui, setter, &g.threshold, "Umbral", C_GATE, k, false);
                if g.mode.value() == GateModeP::Gate {
                    knob(ui, setter, &g.hysteresis, "Histéresis", C_GATE, k, false);
                } else {
                    knob(ui, setter, &g.ratio, "Ratio", C_GATE, k, false);
                }
                knob(ui, setter, &g.range, "Rango", C_GATE, k, false);
                knob(ui, setter, &g.attack, "Ataque", C_GATE, k, false);
                knob(ui, setter, &g.hold, "Mantener", C_GATE, k, false);
                knob(ui, setter, &g.release, "Liberación", C_GATE, k, false);
                knob(ui, setter, &g.key_hpf, "Clave HPF", C_GATE, k, false);
                knob(ui, setter, &g.key_lpf, "Clave LPF", C_GATE, k, false);
            });
        });
        // Column 2: de-esser and compressors
        column(ui, &mut |ui| {
            let d = &p.deesser;
            module_card(
                ui,
                w,
                "De-esser",
                C_DEESS,
                setter,
                &d.on,
                Some(s[4]),
                |ui| {
                    segmented(ui, setter, &d.mode, C_DEESS);
                    switch(ui, setter, &d.listen, C_DEESS, ["ESCUCHA", "ESCUCHA"]);
                },
                |ui| {
                    knob(ui, setter, &d.freq, "Frecuencia", C_DEESS, k, false);
                    knob(ui, setter, &d.q, "Ancho (Q)", C_DEESS, k, false);
                    knob(ui, setter, &d.threshold, "Umbral", C_DEESS, k, false);
                    knob(ui, setter, &d.ratio, "Ratio", C_DEESS, k, false);
                    knob(ui, setter, &d.range, "Reducción máx.", C_DEESS, k, false);
                },
            );
            comp_card(ui, w, "Compresor 1 · picos", C_COMP1, setter, &p.comp1, s[5], k);
            comp_card(ui, w, "Compresor 2 · nivelador", C_COMP2, setter, &p.comp2, s[6], k);
        });
        // Column 3: saturation and limiter
        column(ui, &mut |ui| {
            let sa = &p.saturation;
            module_card(ui, w, "Saturador", C_SAT, setter, &sa.on, None, |ui| segmented(ui, setter, &sa.mode, C_SAT), |ui| {
                knob(ui, setter, &sa.drive, "Drive", C_SAT, k, false);
                knob(ui, setter, &sa.tone, "Tono", C_SAT, k, false);
                knob(ui, setter, &sa.mix, "Mezcla", C_SAT, k, false);
            });
            let l = &p.limiter;
            module_card(ui, w, "Limitador (look-ahead)", C_LIM, setter, &l.on, Some(s[7]), |_| {}, |ui| {
                knob(ui, setter, &l.ceiling, "Techo", C_LIM, k, false);
                knob(ui, setter, &l.release, "Liberación", C_LIM, k, false);
            });
            ui.label(small("Ninguna muestra pasa del techo: protege la mezcla y los oídos de un grito o un golpe al micro."));
            ui.add_space(4.0);
            ui.label(small(&format!("Latencia fija de {:.1} ms: el DAW la compensa solo.", latency_ms(sh.sample_rate.load(Ordering::Relaxed)))));
        });
    });
}

fn comp_card(ui: &mut egui::Ui, w: f32, title: &str, color: Color32, setter: &ParamSetter, c: &CompParams, gr: f32, k: f32) {
    module_card(
        ui,
        w,
        title,
        color,
        setter,
        &c.on,
        Some(gr),
        |ui| {
            segmented(ui, setter, &c.detector, color);
            switch(ui, setter, &c.auto_makeup, color, ["AUTO GAIN", "AUTO GAIN"]);
        },
        |ui| {
            knob(ui, setter, &c.threshold, "Umbral", color, k, false);
            knob(ui, setter, &c.ratio, "Ratio", color, k, false);
            knob(ui, setter, &c.knee, "Rodilla", color, k, false);
            knob(ui, setter, &c.attack, "Ataque", color, k, false);
            knob(ui, setter, &c.release, "Liberación", color, k, false);
            knob(ui, setter, &c.makeup, "Compensación", color, k, true);
            knob(ui, setter, &c.mix, "Mezcla", color, k, false);
            knob(ui, setter, &c.sc_hpf, "SC HPF", color, k, false);
        },
    );
}
