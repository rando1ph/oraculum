import java.net.URI
import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
val releaseIdentity = JsonSlurper().parse(rootProject.file("../../release.json")) as Map<*, *>
val releaseName = releaseIdentity["version"] as String
val releaseCode = releaseIdentity["androidVersionCode"].toString().toInt()
require(Regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?$").matches(releaseName) && releaseCode > 0) {
    "Invalid release.json Android version"
}
val configuredOrigin = providers.gradleProperty("oraculumOrigin").orNull.orEmpty()
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
        applicationId = "dev.oraculum.poc"
        minSdk = 26
        targetSdk = 35
        versionCode = releaseCode
        versionName = releaseName
    }
    buildTypes {
        getByName("release") {
            isDebuggable = false
            // Preserve the approved original PNG bytes for package verification.
            isCrunchPngs = false
            // AGP persists password-derived task inputs even with build caches disabled.
            // Signing therefore belongs to the separate local interactive apksigner step.
            signingConfig = null
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
}

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
            "sourceDirty" to git("status", "--porcelain").isNotEmpty(),
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
