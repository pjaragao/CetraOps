import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Assinatura de release: keystore fora do git (keystore.properties na raiz do app). Sem ela, o release sai sem assinar.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "br.com.cetraops.pdv.loja"
    compileSdk = 35
    buildToolsVersion = "35.0.0"         // a mesma do contêiner de build (scripts/Dockerfile.build)

    defaultConfig {
        // Padrão exigido pela Stone: br.com.<empresa>.<app>.<livre>, sem "stone" nem fabricante/modelo de terminal
        applicationId = "br.com.cetraops.pdv.loja"
        minSdk = 23                      // Stone: Android 6.0+ (terminais de 7.1 a 11)
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"            // Stone: só números e pontos, até 12 caracteres
        // Esquema de retorno dos Deeplinks da Stone (pagamento, cancelamento, impressão)
        manifestPlaceholders["returnScheme"] = "cetraopspdv"
        buildConfigField("String", "RETURN_SCHEME", "\"cetraopspdv\"")
        buildConfigField("String", "DEFAULT_SERVER", "\"${project.findProperty("pdvServerUrl") ?: ""}\"")
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a") }    // terminais Stone são ARM; corta as bibliotecas x86 do ML Kit
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystoreProps.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = ".1"          // continua só número e ponto
        }
    }

    compileOptions {
        isCoreLibraryDesugaringEnabled = true      // java.time no Android 6/7 (terminais L300, P2)
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.mlkit.barcode)          // modelo embutido: funciona sem Google Play Services (ausente nos terminais)
    implementation(libs.zxing.core)             // gera o QR Code da NFC-e para impressão
    implementation(libs.androidx.security.crypto)
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    testImplementation(libs.junit)
}
