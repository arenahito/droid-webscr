plugins {
    kotlin("jvm") version "2.4.0"
    application
    jacoco
}

fun androidSdkRoot(): File {
    val sdk = providers.environmentVariable("ANDROID_HOME")
        .orElse(providers.environmentVariable("ANDROID_SDK_ROOT"))
        .orNull
        ?: error("ANDROID_HOME or ANDROID_SDK_ROOT must point to an Android SDK.")
    return file(sdk)
}

fun latestAndroidJar(): File {
    val platforms = androidSdkRoot().resolve("platforms")
    val jar = platforms
        .listFiles { file -> file.isDirectory && file.name.startsWith("android-") }
        ?.mapNotNull { platform ->
            val version = platform.name.removePrefix("android-").replace(".", "").toIntOrNull()
            version?.let { it to platform.resolve("android.jar") }
        }
        ?.filter { (_, jar) -> jar.isFile }
        ?.maxByOrNull { (version, _) -> version }
        ?.second
    return jar ?: error("No android.jar was found under ${platforms.absolutePath}.")
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("dev.droidwebscr.server.MainKt")
}

dependencies {
    compileOnly(files(latestAndroidJar()))
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed", "skipped", "passed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
    finalizedBy(tasks.jacocoTestReport)
}

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports {
        xml.required.set(true)
        html.required.set(true)
    }
}
