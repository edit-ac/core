plugins {
    id("com.android.application") version "8.10.1"
    kotlin("android") version "2.2.0"
}
android {
    namespace = "ac.edit.controlprobe"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "ac.edit.controlprobe"
        minSdk = 35
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        ndk { abiFilters += "arm64-v8a" }
    }
    sourceSets["main"].apply {
        java.srcDir(providers.gradleProperty("bindingsDir"))
        assets.srcDir(providers.gradleProperty("fixtureDir"))
        jniLibs.srcDir(providers.gradleProperty("nativeDir"))
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { jniLibs.useLegacyPackaging = true }
}
kotlin { jvmToolchain(17) }
dependencies {
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    implementation("com.google.code.gson:gson:2.13.1")
}
dependencyLocking { lockAllConfigurations() }
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions.freeCompilerArgs.add("-opt-in=kotlin.ExperimentalUnsignedTypes")
}
