fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
        println!("cargo:rustc-link-lib=framework=IOSurface");
        cc::Build::new()
            .file("src/capture_sck.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("capture_sck");
    }
}
