package br.com.cetraops.pdv.loja

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import br.com.cetraops.pdv.loja.stone.DeeplinkBus
import br.com.cetraops.pdv.loja.ui.PdvRoot
import br.com.cetraops.pdv.loja.ui.PdvTheme

/** Única tela do app. Os apps da Stone devolvem pagamento/estorno/impressão para cá (singleTask + intent-filter do esquema de retorno). */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        deliver(intent)
        setContent { PdvTheme { PdvRoot(application as PdvApp) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        deliver(intent)
    }

    /** Entrega o retorno uma vez só (tira o dado do intent: a tela recriada não reprocessa um pagamento). */
    private fun deliver(intent: Intent?) {
        val data = intent?.data ?: return
        // erros do app de pagamento podem vir em formatos inesperados: nunca derrubam o PDV
        runCatching { if (data.scheme == BuildConfig.RETURN_SCHEME) DeeplinkBus.publish(data) }
        intent.data = null
        setIntent(intent)
    }
}
