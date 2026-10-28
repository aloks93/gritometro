import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val ndkVer = "27.2.12479018"
val minSdkVer = 26

// Version comes from android/version.properties (one place for the app, CI and the release tag)
val versionProps = Properties().apply { rootProject.file("version.properties").inputStream().use { load(it) } }

android {
    namespace = "com.gritometro.procesador"
    compileSdk = 35
    ndkVersion = ndkVer

    defaultConfig {
        applicationId = "com.gritometro.procesador"
        minSdk = minSdkVer
        targetSdk = 35
        versionCode = versionProps.getProperty("versionCode").toInt()
        versionName = versionProps.getProperty("versionName")
    }

    // Release key from the environment (local: see android/README.md; CI: repository secrets).
    // Without it the release APK is signed with the debug key, so a build never fails for lack of it.
    val ks = System.getenv("GRIT_KEYSTORE")
    signingConfigs {
        if (ks != null && file(ks).exists()) {
            create("release") {
                storeFile = file(ks)
                storePassword = System.getenv("GRIT_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("GRIT_KEY_ALIAS") ?: "gritometro"
                keyPassword = System.getenv("GRIT_KEY_PASSWORD") ?: System.getenv("GRIT_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("rustJniLibs"))
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("presetAssets"))
}

// ---- Native DSP (android/native, Rust): built for every ABI with the NDK's clang as linker

val rustAbis = listOf(
    Triple("arm64-v8a", "aarch64-linux-android", "aarch64-linux-android"),
    Triple("armeabi-v7a", "armv7-linux-androideabi", "armv7a-linux-androideabi"),
    Triple("x86_64", "x86_64-linux-android", "x86_64-linux-android"),
)

val cargoBuild by tasks.registering {
    val nativeDir = rootProject.file("native")
    val outDir = layout.buildDirectory.dir("rustJniLibs").get().asFile
    inputs.dir(nativeDir.resolve("src"))
    inputs.file(nativeDir.resolve("Cargo.toml"))
    inputs.file(rootProject.file("../plugin/src/dsp.rs"))
    outputs.dir(outDir)
    doLast {
        val os = System.getProperty("os.name").lowercase()
        val windows = os.contains("windows")
        val host = when {
            windows -> "windows-x86_64"
            os.contains("mac") -> "darwin-x86_64"
            else -> "linux-x86_64"
        }
        val sdkDir = androidComponents.sdkComponents.sdkDirectory.get().asFile
        val bin = sdkDir.resolve("ndk/$ndkVer/toolchains/llvm/prebuilt/$host/bin")
        val ext = if (windows) ".cmd" else ""
        for ((abi, target, clang) in rustAbis) {
            val key = target.uppercase().replace('-', '_')
            val pb = ProcessBuilder("cargo", "build", "--release", "--target", target)
                .directory(nativeDir)
                .inheritIO()
            pb.environment()["CARGO_TARGET_${key}_LINKER"] = bin.resolve("$clang$minSdkVer-clang$ext").absolutePath
            pb.environment()["CARGO_TARGET_${key}_AR"] = bin.resolve("llvm-ar" + if (windows) ".exe" else "").absolutePath
            val code = pb.start().waitFor()
            if (code != 0) throw GradleException("cargo build failed for $target")
            val so = nativeDir.resolve("target/$target/release/libgritometro_android.so")
            val dest = outDir.resolve(abi)
            dest.mkdirs()
            so.copyTo(dest.resolve(so.name), overwrite = true)
        }
    }
}

// The built-in presets (use × mic) are the plugin's presets.json, generated from the app
val copyPresets by tasks.registering(Copy::class) {
    from(rootProject.file("../plugin/presets.json"))
    into(layout.buildDirectory.dir("presetAssets"))
}

tasks.named("preBuild") { dependsOn(cargoBuild, copyPresets) }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
