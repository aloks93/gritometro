// The plugin as a standalone app (cargo run --release --features standalone), handy to try the editor
fn main() {
    nih_plug::nih_export_standalone::<gritometro_procesador::GritProcesador>();
}
