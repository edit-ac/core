plugins {
    kotlin("jvm") version "2.2.0"
    application
}
repositories { mavenCentral() }
dependencies {
    implementation("net.java.dev.jna:jna:5.17.0")
    implementation("com.google.code.gson:gson:2.13.1")
}
kotlin { jvmToolchain(17) }
application { mainClass.set("ProbeKt") }
sourceSets.main { kotlin.srcDir(providers.gradleProperty("bindingsDir")) }
dependencyLocking { lockAllConfigurations() }
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions.freeCompilerArgs.add("-opt-in=kotlin.ExperimentalUnsignedTypes")
}
