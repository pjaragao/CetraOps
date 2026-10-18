package br.com.cetraops.pdv.loja.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import br.com.cetraops.pdv.loja.BuildConfig
import br.com.cetraops.pdv.loja.R
import br.com.cetraops.pdv.loja.data.SecureStore

@Composable
fun SettingsScreen(ui: AppUi, store: SecureStore, onTestPrint: () -> Unit, onCatalog: () -> Unit, onLogout: () -> Unit, onUnpair: () -> Unit) {
    var cols by remember { mutableIntStateOf(store.printColumns) }
    var auto by remember { mutableStateOf(store.autoPrintNfce) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(ui.storeName ?: "Loja", style = MaterialTheme.typography.titleMedium)
                Text("Maquininha: ${ui.deviceName ?: "—"}")
                Text("Operador: ${ui.boot?.operator?.name ?: "—"}")
                Text("Catálogo: ${ui.catalogCount} produtos" + if (ui.catalogUpdating) " (atualizando…)" else "")
                Text("Caixa: ${if (ui.boot?.cashSessionId != null) "aberto" else "fechado (dinheiro indisponível)"}")
                Text("Stone: ${ui.boot?.stoneEnvironment ?: "—"} · app ${BuildConfig.VERSION_NAME}")
            }
        }
        Text("Impressão", style = MaterialTheme.typography.titleMedium)
        Text("Colunas da bobina (texto pequeno): escolha a que preenche a linha sem quebrar no teste.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (c in listOf(32, 40, 42, 48)) FilterChip(cols == c, { cols = c; store.printColumns = c }, label = { Text("$c") })
        }
        OutlinedButton(onTestPrint, Modifier.fillMaxWidth()) { Text("Imprimir teste") }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Imprimir a NFC-e assim que a SEFAZ autorizar", Modifier.weight(1f))
            Switch(auto, { auto = it; store.autoPrintNfce = it })
        }
        Button(onCatalog, Modifier.fillMaxWidth()) { Text("Atualizar catálogo agora") }
        OutlinedButton(onLogout, Modifier.fillMaxWidth()) { Text("Trocar de usuário") }
        OutlinedButton(onUnpair, Modifier.fillMaxWidth()) { Text("Desfazer pareamento") }
        ContactCard()
    }
}

/** “Fale conosco” — exigido pela Stone, visível e fácil de achar. */
@Composable
fun ContactCard() = Card(Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Fale conosco", style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.support_text))
        Text("Pagamento, estorno e comprovante do cartão: app e central da Stone (no menu do terminal).", style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
fun ContactScreen(onBack: () -> Unit) = Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    ContactCard()
    Button(onBack, Modifier.fillMaxWidth()) { Text("Voltar") }
}
