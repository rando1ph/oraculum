import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
val configuredOrigin = providers.gradleProperty("oraculumOrigin").orNull.orEmpty()
if (configuredOrigin.isNotEmpty()) {
    val uri = URI(configuredOrigin)
    require(uri.scheme == "https" && uri.host != null && uri.userInfo == null &&
        uri.path in listOf("", "/") && uri.query == null && uri.fragment == null) {
        "oraculumOrigin must be an exact HTTPS origin"
    }
}
android {
    namespace = "dev.oraculum.poc"
    compileSdk = 35
    buildToolsVersion = "35.0.0"
    defaultConfig {
        buildConfigField("String", "ORACULUM_ORIGIN", "\"${configuredOrigin.trimEnd('/')}\"")
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
