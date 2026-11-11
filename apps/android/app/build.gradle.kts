import java.net.URI
import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}
val releaseIdentity = JsonSlurper().parse(rootProject.file("../../release.json")) as Map<*, *>
val releaseName = releaseIdentity["version"] as String
val releaseCode = releaseIdentity["androidVersionCode"].toString().toInt()
require(Regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?$").matches(releaseName) && releaseCode > 0) {
    "Invalid release.json Android version"
}
val configuredOrigin = providers.gradleProperty("oraculumOrigin").orNull.orEmpty()
val debugPort = providers.gradleProperty("oraculumDebugPort").getOrElse("17860").toInt()
require(debugPort in 1024..65535) { "Invalid Debug loopback port" }
val rawBasePath = providers.gradleProperty("oraculumBasePath").getOrElse("/")
require(rawBasePath.startsWith("/") && Regex("^/[A-Za-z0-9._~/-]*$").matches(rawBasePath) &&
    !rawBasePath.contains("//") && rawBasePath.split('/').none { it == "." || it == ".." }) {
    "oraculumBasePath must be an absolute path without escapes, empty or dot segments"
}
val configuredBasePath = if (rawBasePath.endsWith("/")) rawBasePath else "$rawBasePath/"
require(configuredOrigin.isNotEmpty() || configuredBasePath == "/") { "Base Path requires an HTTPS origin" }
if (configuredOrigin.isNotEmpty()) {
    val uri = URI(configuredOrigin)
    require(uri.scheme == "https" && uri.host != null && uri.userInfo == null &&
        uri.rawPath in listOf("", "/") && uri.query == null && uri.fragment == null &&
        (uri.port == -1 || uri.port in 1..65535)) {
        "oraculumOrigin must be an exact HTTPS origin"
    }
}
android {
    namespace = "dev.oraculum.poc"
    compileSdk = 35
    buildToolsVersion = "35.0.0"
    defaultConfig {
        buildConfigField("String", "ORACULUM_ORIGIN", "\"${configuredOrigin.trimEnd('/')}\"")
        buildConfigField("String", "ORACULUM_BASE_PATH", "\"$configuredBasePath\"")
        buildConfigField("int", "ORACULUM_DEBUG_PORT", debugPort.toString())
        applicationId = "dev.oraculum.poc"
        minSdk = 26
        targetSdk = 35
        versionCode = releaseCode
        versionName = releaseName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            resValue("string", "app_name", "神谕 Debug")
        }
        getByName("release") {
            isDebuggable = false
            // Preserve the approved original PNG bytes for package verification.
            isCrunchPngs = false
            // AGP persists password-derived task inputs even with build caches disabled.
            // Signing therefore belongs to the separate local interactive apksigner step.
            signingConfig = null
        }
    }
    buildFeatures { buildConfig = true; compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.04.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.room:room-runtime:2.7.2")
    implementation("androidx.room:room-ktx:2.7.2")
    ksp("androidx.room:room-compiler:2.7.2")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.04.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

android.sourceSets["main"].java.srcDir(rootProject.file("../../packages/gateway-protocol/generated"))
ksp { arg("room.schemaLocation", "$projectDir/schemas") }

// A disposable local CA may be included in Debug builds only. It is never a
// product trust override, release asset, or hostname-verification bypass.
val debugCa = providers.gradleProperty("oraculumDebugCa").orNull
val prepareDebugTrust by tasks.registering {
    val destination = layout.buildDirectory.dir("generated/debug-trust/res")
    inputs.property("debugCa", debugCa.orEmpty())
    if (debugCa != null) inputs.file(file(debugCa))
    outputs.dir(destination)
    doLast {
        val directory = destination.get().asFile
        delete(directory)
        directory.resolve("xml").mkdirs()
        val debugOverride = if (debugCa != null) {
            val source = file(debugCa)
            val bytes = source.readBytes()
            require(!bytes.toString(Charsets.US_ASCII).contains("PRIVATE KEY")) { "Debug CA must not contain private key material" }
            val certificate = CertificateFactory.getInstance("X.509")
                .generateCertificate(bytes.inputStream()) as X509Certificate
            require(certificate.basicConstraints >= 0) { "Debug trust input must be a CA certificate" }
            certificate.checkValidity()
            directory.resolve("raw").mkdirs()
            directory.resolve("raw/oraculum_debug_ca.pem").writeBytes(bytes)
            "<debug-overrides><trust-anchors><certificates src=\"@raw/oraculum_debug_ca\" /></trust-anchors></debug-overrides>"
        } else ""
        directory.resolve("xml/network_security_config.xml").writeText("""
            <?xml version="1.0" encoding="utf-8"?>
            <network-security-config>
                <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>
                $debugOverride
            </network-security-config>
        """.trimIndent() + "\n")
    }
}
android.sourceSets["debug"].res.srcDir(layout.buildDirectory.dir("generated/debug-trust/res"))
tasks.matching { it.name == "preDebugBuild" }.configureEach { dependsOn(prepareDebugTrust) }

// Reuse the approved original without duplicating or redesigning the brand asset.
val prepareBrandIcon by tasks.registering(Copy::class) {
    from(rootProject.file("../../design/reference/02_Brand_OracleEye_App_Icon.png")) {
        rename { "oracle_eye.png" }
    }
    from(rootProject.file("../../design/reference/03_Brand_OracleEye_Simplified_Icon.png")) {
        rename { "oracle_eye_mark.png" }
    }
    into(layout.buildDirectory.dir("generated/brand/res/drawable-nodpi"))
}
android.sourceSets["main"].res.srcDir(layout.buildDirectory.dir("generated/brand/res"))
tasks.named("preBuild").configure { dependsOn(prepareBrandIcon) }

val prepareBuildIdentity by tasks.registering {
    val metadata = layout.buildDirectory.file("generated/build-identity/assets/oraculum-build.json")
    outputs.file(metadata)
    outputs.upToDateWhen { false }
    doLast {
        fun git(vararg arguments: String): String = providers.exec {
            workingDir(rootProject.file("../.."))
            commandLine(listOf("git") + arguments)
        }.standardOutput.asText.get().trim()
        val sourceGit = git("rev-parse", "HEAD")
        require(Regex("^[a-f0-9]{40}$").matches(sourceGit)) { "Invalid source Git identity" }
        val file = metadata.get().asFile
        file.parentFile.mkdirs()
        file.writeText(JsonOutput.toJson(mapOf("format" to 1, "sourceGit" to sourceGit,
            // User-owned read-only design input is deliberately outside source publication.
            "sourceDirty" to git("status", "--porcelain", "--", ".", ":(exclude)upgrade/stitch_oraculum_android_workspace/").isNotEmpty(),
            "version" to releaseName, "versionCode" to releaseCode)) + "\n")
    }
}
android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/build-identity/assets"))
tasks.named("preBuild").configure { dependsOn(prepareBuildIdentity) }

// Small, reviewed notice inventory; upgrades fail until their license coverage is reviewed.
val prepareThirdPartyNotices by tasks.registering {
    val source = rootProject.file("../../packaging/licenses/android")
    val destination = layout.buildDirectory.dir("generated/third-party/assets/third-party")
    inputs.dir(source)
    outputs.dir(destination)
    outputs.upToDateWhen { false }
    doLast {
        val resolved = configurations.getByName("releaseRuntimeClasspath").incoming.resolutionResult
            .allComponents.mapNotNull { it.id as? ModuleComponentIdentifier }
            .map { "${it.group}:${it.module}:${it.version}" }.sorted()
        val manifest = JsonSlurper().parse(source.resolve("manifest.json")) as Map<*, *>
        val packages = manifest["packages"] as List<*>
        val covered = packages.map { (it as Map<*, *>)["coordinate"] as String }.sorted()
        require(resolved == covered) { "Android runtime license inventory differs from resolved dependencies; review notices before building" }
        for (entry in packages) {
            for (notice in (entry as Map<*, *>)["notices"] as List<*>) {
                val fields = notice as Map<*, *>
                val name = fields["path"] as String
                require(Regex("^[A-Za-z0-9_.-]+$").matches(name)) { "Invalid license notice path" }
                val digest = MessageDigest.getInstance("SHA-256").digest(source.resolve(name).readBytes())
                    .joinToString("") { "%02x".format(it) }
                require(digest == fields["sha256"]) { "Android license notice hash mismatch" }
            }
        }
        val directory = destination.get().asFile
        delete(directory)
        copy { from(source); into(directory) }
        directory.resolve("runtime-components.json").writeText(JsonOutput.toJson(mapOf(
            "format" to 1, "scope" to "releaseRuntimeClasspath", "components" to resolved)) + "\n")
    }
}
android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/third-party/assets"))
tasks.named("preBuild").configure { dependsOn(prepareThirdPartyNotices) }
