package br.com.cetraops.pdv.loja.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Token da maquininha, sessão do operador e preferências — criptografados no aparelho (Keystore do Android). */
class SecureStore(context: Context) {
    private val prefs: SharedPreferences = try {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "pdv_secure", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        // Keystore corrompido (raro, após restauração): recomeça do zero; o sócio pareia de novo
        java.io.File(context.applicationInfo.dataDir, "shared_prefs/pdv_secure.xml").delete()    // deleteSharedPreferences só existe no Android 7+
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "pdv_secure", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var serverUrl: String?
        get() = prefs.getString("server_url", null)
        set(v) = prefs.edit().putString("server_url", v).apply()

    var deviceToken: String?
        get() = prefs.getString("device_token", null)
        set(v) = prefs.edit().putString("device_token", v).apply()

    var deviceName: String?
        get() = prefs.getString("device_name", null)
        set(v) = prefs.edit().putString("device_name", v).apply()

    var storeName: String?
        get() = prefs.getString("store_name", null)
        set(v) = prefs.edit().putString("store_name", v).apply()

    var lastEmail: String?
        get() = prefs.getString("last_email", null)
        set(v) = prefs.edit().putString("last_email", v).apply()

    /** Colunas da bobina para o texto pequeno (depende do modelo do terminal; ajustável em Ajustes). */
    var printColumns: Int
        get() = prefs.getInt("print_columns", 40)
        set(v) = prefs.edit().putInt("print_columns", v).apply()

    var autoPrintNfce: Boolean
        get() = prefs.getBoolean("auto_print_nfce", true)
        set(v) = prefs.edit().putBoolean("auto_print_nfce", v).apply()

    var session: SessionTokens?
        get() {
            val a = prefs.getString("access_token", null) ?: return null
            val r = prefs.getString("refresh_token", null) ?: return null
            return SessionTokens(a, r, prefs.getLong("expires_at", 0))
        }
        set(v) {
            prefs.edit().apply {
                if (v == null) { remove("access_token"); remove("refresh_token"); remove("expires_at") }
                else { putString("access_token", v.accessToken); putString("refresh_token", v.refreshToken); putLong("expires_at", v.expiresAt) }
            }.apply()
        }

    fun unpair() {
        prefs.edit().remove("device_token").remove("device_name").remove("store_name")
            .remove("access_token").remove("refresh_token").remove("expires_at").apply()
    }
}
