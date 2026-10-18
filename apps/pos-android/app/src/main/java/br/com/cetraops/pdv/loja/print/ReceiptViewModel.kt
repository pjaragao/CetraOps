package br.com.cetraops.pdv.loja.print

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import br.com.cetraops.pdv.loja.PdvApp
import br.com.cetraops.pdv.loja.data.ApiException
import br.com.cetraops.pdv.loja.data.ReceiptResponse
import br.com.cetraops.pdv.loja.stone.StoneDeeplink
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ReceiptUi(
    val orderId: String? = null,
    val data: ReceiptResponse? = null,
    val waitingNfce: Boolean = false,
    val printing: Boolean = false,
    val message: String? = null,
)

/**
 * Depois da venda: acompanha a NFC-e (emitida pelo servidor logo após a venda) e imprime o DANFE na bobina quando a SEFAZ autoriza.
 * Também reimprime vendas de hoje.
 */
class ReceiptViewModel(app: Application) : AndroidViewModel(app) {
    private val g = app as PdvApp
    private val _ui = MutableStateFlow(ReceiptUi())
    val ui: StateFlow<ReceiptUi> = _ui.asStateFlow()
    private var poll: Job? = null

    fun open(orderId: String, autoPrint: Boolean) {
        if (_ui.value.orderId == orderId) return
        poll?.cancel()
        _ui.value = ReceiptUi(orderId = orderId, waitingNfce = true)
        poll = viewModelScope.launch {
            // a emissão vai pela fila do servidor: consulta por até ~1 minuto
            repeat(20) { attempt ->
                val r = runCatching { g.api.receipt(orderId) }.getOrNull()
                if (r != null) {
                    _ui.update { it.copy(data = r) }
                    val st = r.fiscal?.status
                    if (r.fiscal?.nfce?.danfe != null) {
                        _ui.update { it.copy(waitingNfce = false) }
                        if (autoPrint) printNfce()
                        return@launch
                    }
                    if (st in setOf("REJECTED", "DENIED", "CONTINGENCY_PENDING") || (r.fiscal != null && r.fiscal.nfce == null && st == "AUTHORIZED")) {
                        _ui.update { it.copy(waitingNfce = false, message = r.fiscal?.message?.let { m -> "NFC-e: $m" }) }
                        return@launch
                    }
                }
                delay(if (attempt < 5) 2_000 else 4_000)
            }
            _ui.update { it.copy(waitingNfce = false, message = "A NFC-e ainda não saiu. Reimprima depois em Vendas de hoje.") }
        }
    }

    fun reload() {
        val id = _ui.value.orderId ?: return
        _ui.value = ReceiptUi()
        open(id, autoPrint = false)
    }

    fun printNfce() = viewModelScope.launch {
        val d = _ui.value.data?.fiscal?.nfce?.danfe ?: run { _ui.update { it.copy(message = "NFC-e ainda não autorizada") }; return@launch }
        run(Receipts(g.store.printColumns).danfe(d, cancelled = _ui.value.data?.fiscal?.status == "CANCELLED"))
    }

    fun printReceipt() = viewModelScope.launch {
        val r = _ui.value.data ?: return@launch
        val note = when {
            r.fiscal?.nfce?.danfe != null -> null
            r.fiscal?.consultUrl != null -> "NFC-e: consulte em ${r.fiscal.consultUrl}"
            else -> "NFC-e em processamento: peça a via fiscal na loja."
        }
        run(Receipts(g.store.printColumns).saleReceipt(g.store.storeName ?: "Loja", r.order, note))
    }

    fun printRuler() = viewModelScope.launch { run(Receipts(g.store.printColumns).ruler()) }

    private suspend fun run(blocks: List<Receipts.Block>) {
        _ui.update { it.copy(printing = true, message = null) }
        val status = try { g.printer.print(blocks) } catch (e: ApiException) { StoneDeeplink.PrintStatus.UNKNOWN }
        _ui.update { it.copy(printing = false, message = if (status == StoneDeeplink.PrintStatus.SUCCESS) null else status.message) }
    }

    fun clear() { poll?.cancel(); _ui.value = ReceiptUi() }
}
