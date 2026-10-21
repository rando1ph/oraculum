import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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
        versionCode = 1
        versionName = "0.0.1-phase0b"
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
