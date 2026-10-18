package br.com.cetraops.pdv.loja.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.cetraops.pdv.loja.PdvApp
import br.com.cetraops.pdv.loja.core.Money
import br.com.cetraops.pdv.loja.data.SaleSummary
import br.com.cetraops.pdv.loja.print.ReceiptViewModel
import br.com.cetraops.pdv.loja.sale.SaleViewModel

@Composable
fun PdvRoot(app: PdvApp) {
    val appVm: AppViewModel = viewModel()
    val ui by appVm.ui.collectAsStateWithLifecycle()
    var contact by rememberSaveable { mutableStateOf(false) }
    if (contact) { ContactScreen { contact = false }; return }
    when (ui.stage) {
        Stage.PAIRING -> PairingScreen(ui, appVm::pair) { contact = true }
        Stage.LOGIN -> LoginScreen(ui, appVm::login, appVm::unpair) { contact = true }
        Stage.LOADING -> LoadingScreen(ui, appVm::open, appVm::logout)
        Stage.READY -> MainScreen(app, ui, appVm)
    }
}

private enum class Tab { SALE, TODAY, SETTINGS }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainScreen(app: PdvApp, ui: AppUi, appVm: AppViewModel) {
    val saleVm: SaleViewModel = viewModel()
    val receiptVm: ReceiptViewModel = viewModel()
    val sale by saleVm.ui.collectAsStateWithLifecycle()
    val receipt by receiptVm.ui.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.SALE) }
    var checkout by rememberSaveable { mutableStateOf(sale.draft.locked) }
    var detail by remember { mutableStateOf<SaleSummary?>(null) }
    val boot = ui.boot ?: return
    saleVm.stoneSandbox = boot.stoneEnvironment == "sandbox"

    LaunchedEffect(sale.finished?.orderId) {
        sale.finished?.let { receiptVm.open(it.orderId, autoPrint = app.store.autoPrintNfce); checkout = false }
    }
    BackHandler(enabled = checkout || detail != null) { if (detail != null) detail = null else checkout = false }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Column { Text(boot.store.name, style = MaterialTheme.typography.titleMedium); Text(boot.operator.name, style = MaterialTheme.typography.bodyMedium) } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.secondary, titleContentColor = MaterialTheme.colorScheme.onSecondary),
            )
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(tab == Tab.SALE, { tab = Tab.SALE }, { Icon(Icons.Default.PointOfSale, null) }, label = { Text("Vender") })
                NavigationBarItem(tab == Tab.TODAY, { tab = Tab.TODAY; detail = null }, { Icon(Icons.AutoMirrored.Filled.ReceiptLong, null) }, label = { Text("Vendas de hoje") })
                NavigationBarItem(tab == Tab.SETTINGS, { tab = Tab.SETTINGS }, { Icon(Icons.Default.Settings, null) }, label = { Text("Ajustes") })
            }
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            Banner(sale.message ?: receipt.message.takeIf { tab != Tab.SALE }, sale.error ?: ui.error, onDismiss = { saleVm.dismissMessages(); appVm.clearError() })
            when (tab) {
                Tab.SALE -> {
                    val f = sale.finished
                    when {
                        f != null -> DoneScreen(f.number, f.totalCents, f.changeCents, receipt, receiptVm) { saleVm.closeFinished(); receiptVm.clear() }
                        checkout -> CheckoutScreen(sale, saleVm, boot.operator, boot.cashSessionId != null) { checkout = false }
                        else -> CartScreen(sale, saleVm, app.catalog) { checkout = true }
                    }
                }
                Tab.TODAY -> detail?.let { SaleDetail(it, receipt, receiptVm) { detail = null; receiptVm.clear() } }
                    ?: TodaySales(ui.todaySales, appVm::loadToday) { s -> receiptVm.clear(); detail = s }
                Tab.SETTINGS -> SettingsScreen(ui, app.store, receiptVm::printRuler, appVm::refreshCatalog, appVm::logout, appVm::unpair)
            }
        }
    }

    BusyOverlay(sale.busy, if (sale.draft.pending != null) "Não voltou da Stone?" to saleVm::giveUpWaiting else null)

    sale.orphanCharge?.let { p ->
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Cobrança sem resposta") },
            text = { Text("A cobrança de ${Money.format(p.amountCents)} (${p.method.label}) não voltou do app da Stone. Confira no app/relatório da Stone se foi aprovada.") },
            confirmButton = { Button({ saleVm.resolveOrphan(approvedAtStone = true) }) { Text("Foi aprovada: estornar") } },
            dismissButton = { TextButton({ saleVm.resolveOrphan(approvedAtStone = false) }) { Text("Não foi aprovada") } },
        )
    }
    sale.simulate?.let { p ->
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Simulador (build de teste)") },
            text = { Text("Sem o app da Stone neste aparelho. Simular ${p.method.label} de ${Money.format(p.amountCents)}?") },
            confirmButton = { Button({ saleVm.simulateResult(true) }) { Text("Aprovar") } },
            dismissButton = { TextButton({ saleVm.simulateResult(false) }) { Text("Recusar") } },
        )
    }
}
