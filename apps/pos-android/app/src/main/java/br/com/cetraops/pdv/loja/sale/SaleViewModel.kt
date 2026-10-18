package br.com.cetraops.pdv.loja.sale

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import br.com.cetraops.pdv.loja.BuildConfig
import br.com.cetraops.pdv.loja.PdvApp
import br.com.cetraops.pdv.loja.core.Money
import br.com.cetraops.pdv.loja.data.ApiException
import br.com.cetraops.pdv.loja.data.CatalogStore
import br.com.cetraops.pdv.loja.data.CloseChargeRequest
import br.com.cetraops.pdv.loja.data.ConfirmChargeRequest
import br.com.cetraops.pdv.loja.data.CustomerRequest
import br.com.cetraops.pdv.loja.data.OpenChargeRequest
import br.com.cetraops.pdv.loja.data.PosProduct
import br.com.cetraops.pdv.loja.data.PosVariant
import br.com.cetraops.pdv.loja.data.SaleItemDto
import br.com.cetraops.pdv.loja.data.SalePaymentDto
import br.com.cetraops.pdv.loja.data.SaleRequest
import br.com.cetraops.pdv.loja.stone.DeeplinkBus
import br.com.cetraops.pdv.loja.stone.StoneDeeplink
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID

data class SaleUi(
    val draft: SaleDraft,
    val busy: String? = null,
    val message: String? = null,
    val error: String? = null,
    /** peça pela referência: escolher cor/tamanho */
    val picking: List<PosProduct>? = null,
    /** cobrança pendente sem retorno da Stone (o app foi fechado no meio): perguntar ao operador */
    val orphanCharge: PendingCharge? = null,
    /** o app da Stone não existe (celular de teste): simulador só no build de teste com a Stone em sandbox */
    val simulate: PendingCharge? = null,
    val finished: FinishedSale? = null,
)

data class FinishedSale(val orderId: String, val number: String, val totalCents: Long, val changeCents: Long)

class SaleViewModel(app: Application) : AndroidViewModel(app) {
    private val g = app as PdvApp
    private val ctx get() = getApplication<Application>()
    private val _ui = MutableStateFlow(SaleUi(g.journal.load() ?: SaleDraft(UUID.randomUUID().toString())))
    val ui: StateFlow<SaleUi> = _ui.asStateFlow()
    var stoneSandbox = false
    private var waitJob: Job? = null

    init {
        // voltou de um fechamento no meio do pagamento: o retorno pode ter chegado junto com a reabertura
        _ui.value.draft.pending?.let { p ->
            viewModelScope.launch {
                if (p.approvedUri != null) { handlePayResult(p, Uri.parse(p.approvedUri)); return@launch }
                val back = withTimeoutOrNull(2_500) { DeeplinkBus.events.first { it.host == "pay-response" } }
                if (back != null) { DeeplinkBus.consume(); handlePayResult(p, back) } else _ui.update { it.copy(orphanCharge = p) }
            }
        }
    }

    private fun edit(f: (SaleDraft) -> SaleDraft) {
        _ui.update { it.copy(draft = f(it.draft)) }
        g.journal.save(_ui.value.draft)
    }
    private fun say(msg: String?) = _ui.update { it.copy(message = msg, error = null) }
    private fun fail(msg: String?) = _ui.update { it.copy(error = msg, message = null, busy = null) }
    fun dismissMessages() = _ui.update { it.copy(message = null, error = null) }

    // ---------- Carrinho ----------
    fun scanned(code: String) {
        if (_ui.value.draft.locked) { fail("Venda já tem pagamento: estorne para mudar os itens"); return }
        when (val r = g.catalog.lookup(code)) {
            is CatalogStore.Lookup.One -> add(r.hit.product, r.hit.variant)
            is CatalogStore.Lookup.Pick -> _ui.update { it.copy(picking = r.products) }
            CatalogStore.Lookup.NotFound -> fail("Código $code não encontrado no catálogo da loja")
        }
    }

    fun pick(products: List<PosProduct>?) = _ui.update { it.copy(picking = products) }

    fun add(product: PosProduct, variant: PosVariant) {
        val d = _ui.value.draft
        if (d.locked) { fail("Venda já tem pagamento: estorne para mudar os itens"); return }
        val inCart = d.lines.filter { it.variant.id == variant.id }.sumOf { it.qty }
        if (inCart + 1 > variant.available) { fail("${product.name} ${variant.size}: sem estoque disponível na loja (${variant.available.toInt()})"); return }
        edit { s ->
            val existing = s.lines.firstOrNull { it.variant.id == variant.id && it.discountCents == 0L }
            if (existing != null) s.copy(lines = s.lines.map { if (it.id == existing.id) it.copy(qty = it.qty + 1) else it })
            else s.copy(lines = s.lines + CartLine(UUID.randomUUID().toString(), product, variant, 1))
        }
        _ui.update { it.copy(picking = null, error = null, message = "${product.name} ${variant.size} adicionada") }
    }

    fun changeQty(lineId: String, delta: Int) {
        if (_ui.value.draft.locked) return
        val line = _ui.value.draft.lines.firstOrNull { it.id == lineId } ?: return
        val inCart = _ui.value.draft.lines.filter { it.variant.id == line.variant.id }.sumOf { it.qty }
        if (delta > 0 && inCart + delta > line.variant.available) { fail("Sem mais estoque desta peça na loja"); return }
        edit { s ->
            s.copy(lines = s.lines.mapNotNull { if (it.id == lineId) (it.qty + delta).takeIf { q -> q > 0 }?.let { q -> it.copy(qty = q, discountCents = minOf(it.discountCents, it.unitCents * q)) } else it })
        }
    }

    fun remove(lineId: String) { if (!_ui.value.draft.locked) edit { s -> s.copy(lines = s.lines.filterNot { it.id == lineId }) } }

    /** Desconto no total (quem tem sales.discount): distribuído entre os itens, sem centavo perdido. */
    fun setDiscount(totalCents: Long, reason: String?) {
        if (_ui.value.draft.locked) return
        edit { s ->
            val parts = Money.distribute(totalCents, s.lines.map { it.grossCents })
            s.copy(lines = s.lines.mapIndexed { i, l -> l.copy(discountCents = parts[i]) }, discountReason = reason?.trim()?.ifBlank { null })
        }
    }

    // ---------- Cliente e cupom ----------
    fun identify(phone: String, name: String, marketing: Boolean) = viewModelScope.launch {
        _ui.update { it.copy(busy = "Buscando cliente…") }
        try {
            val r = g.api.customer(CustomerRequest(phone, name.ifBlank { null }, marketing))
            edit { s -> s.copy(party = r.party, coupon = if (s.coupon == null && !s.locked) r.autoCoupon else s.coupon) }
            _ui.update { it.copy(busy = null, message = "Cliente: ${r.party.name}" + (r.autoCoupon?.let { c -> " · cupom ${c.code} aplicado" } ?: "")) }
        } catch (e: ApiException) { fail(e.message) }
    }

    fun clearCustomer() { if (!_ui.value.draft.locked) edit { it.copy(party = null) } }

    fun setCpf(cpf: String?) {
        val digits = cpf?.filter(Char::isDigit)?.ifBlank { null }
        if (digits != null && !validCpf(digits)) { fail("CPF inválido"); return }
        edit { it.copy(cpf = digits) }
    }

    fun applyCoupon(code: String) = viewModelScope.launch {
        if (_ui.value.draft.locked) { fail("Venda já tem pagamento"); return@launch }
        if (code.isBlank()) { edit { it.copy(coupon = null) }; return@launch }
        _ui.update { it.copy(busy = "Conferindo cupom…") }
        try {
            val c = g.api.coupon(code.trim())
            edit { it.copy(coupon = c) }
            _ui.update { it.copy(busy = null, message = "Cupom ${c.code} aplicado") }
        } catch (e: ApiException) { fail(e.message) }
    }

    // ---------- Pagamento ----------
    fun payCash(receivedCents: Long) {
        val d = _ui.value.draft
        if (d.pending != null) return
        if (receivedCents <= 0) { fail("Informe o valor recebido"); return }
        if (d.remainingCents <= 0) { fail("Nada a receber"); return }
        edit { it.copy(payments = it.payments + Payment(UUID.randomUUID().toString(), PayMethod.CASH, receivedCents)) }
        say(if (receivedCents > d.remainingCents) "Troco: ${Money.format(receivedCents - d.remainingCents)}" else null)
    }

    /** Abre a cobrança no servidor e chama o app de pagamento da Stone; o retorno chega pela MainActivity. */
    fun payWithStone(method: PayMethod, amountCents: Long, installments: Int) = viewModelScope.launch {
        val d = _ui.value.draft
        if (d.pending != null || waitJob?.isActive == true) return@launch
        if (amountCents <= 0 || amountCents > d.remainingCents) { fail("Valor maior que o que falta pagar (${Money.format(d.remainingCents)})"); return@launch }
        val inst = if (method == PayMethod.CREDIT) installments.coerceIn(1, 12) else 1
        _ui.update { it.copy(busy = "Abrindo a cobrança…", error = null) }
        val opened = try {
            g.api.openCharge(OpenChargeRequest(Money.toReais(amountCents), method.api, inst))
        } catch (e: ApiException) { fail(e.message); return@launch }
        val pending = PendingCharge(opened.chargeId, method, amountCents, inst, System.currentTimeMillis())
        edit { it.copy(pending = pending) }

        val uri = StoneDeeplink.paymentUri(amountCents, StoneDeeplink.Method.valueOf(method.api), inst)
        if (!StoneDeeplink.isAvailable(ctx, uri)) {
            if (BuildConfig.DEBUG && stoneSandbox) { _ui.update { it.copy(busy = null, simulate = pending) }; return@launch }
            g.api.runCatching { closeCharge(pending.chargeId, CloseChargeRequest("CANCELLED", message = "App de pagamento da Stone não encontrado")) }
            edit { it.copy(pending = null) }
            fail("App de pagamento da Stone não encontrado neste aparelho")
            return@launch
        }
        _ui.update { it.copy(busy = "Pagamento na maquininha: siga as instruções na tela da Stone") }
        DeeplinkBus.consume()
        ctx.startActivity(StoneDeeplink.intent(uri))
        waitJob = launch {
            val back = DeeplinkBus.events.first { it.host == "pay-response" }
            DeeplinkBus.consume()
            handlePayResult(pending, back)
        }
    }

    /** Build de teste em celular comum: aprova ou recusa sem a Stone (só com a integração em sandbox). */
    fun simulateResult(approve: Boolean) {
        val p = _ui.value.simulate ?: return
        _ui.update { it.copy(simulate = null) }
        val uri = if (approve) Uri.parse("${StoneDeeplink.returnScheme}://pay-response?code=0&amount=${p.amountCents}&atk=SIM${System.currentTimeMillis()}&itk=SIM&authorization_code=000000&brand=SIMULADO&installment_count=${p.installments}&type=${p.method.api}")
                  else Uri.parse("${StoneDeeplink.returnScheme}://pay-response?code=2&message=Simulado%20recusado")
        viewModelScope.launch { handlePayResult(p, uri) }
    }

    private suspend fun handlePayResult(p: PendingCharge, uri: Uri) {
        when (val r = StoneDeeplink.parsePayment(uri)) {
            is StoneDeeplink.PaymentResult.Declined -> {
                g.api.runCatching { closeCharge(p.chargeId, CloseChargeRequest(if (r.code == "2") "CANCELLED" else "FAILED", r.code, r.message.take(200))) }
                edit { it.copy(pending = null) }
                fail(r.message)
            }
            is StoneDeeplink.PaymentResult.Approved -> {
                // valor bloqueado no app da Stone (editable_amount=0): se o retorno não trouxer, é o valor pedido
                val amount = if (r.amountCents > 0) r.amountCents else p.amountCents
                edit { it.copy(pending = p.copy(approvedAtk = r.atk, approvedUri = uri.toString())) }
                _ui.update { it.copy(busy = "Registrando o pagamento…") }
                try {
                    val c = g.api.confirmCharge(p.chargeId, ConfirmChargeRequest(amount, r.atk, r.itk, r.authorizationCode, r.brand, r.installmentCount, r.type, r.pan, r.entryMode, r.authorizationDateTime))
                    edit {
                        it.copy(pending = null, payments = it.payments + Payment(UUID.randomUUID().toString(), p.method, amount, c.installments ?: p.installments, p.chargeId, r.atk, c.authCode ?: r.authorizationCode, c.brand ?: r.brand))
                    }
                    _ui.update { it.copy(busy = null, error = null, message = "${p.method.label} aprovado: ${Money.format(amount)}") }
                } catch (e: ApiException) {
                    if (e.status == 0 || e.status >= 500) fail("Aprovado na Stone, mas sem conexão para registrar. Toque em Tentar de novo.")
                    else {
                        // recusado pelo servidor (valor diferente, transação repetida): estornar na maquininha
                        edit { it.copy(pending = null) }
                        _ui.update { it.copy(busy = null, error = "${e.message}", orphanCharge = null) }
                        refund(Payment(UUID.randomUUID().toString(), p.method, amount, p.installments, p.chargeId, r.atk), registerRefund = false)
                    }
                }
            }
        }
    }

    /** O app da Stone não devolveu o resultado: para de esperar e pergunta ao operador o que aconteceu. */
    fun giveUpWaiting() {
        val p = _ui.value.draft.pending ?: return
        waitJob?.cancel()
        _ui.update { it.copy(busy = null, orphanCharge = p) }
    }

    fun retryPending() = viewModelScope.launch {
        val p = _ui.value.draft.pending ?: return@launch
        p.approvedUri?.let { handlePayResult(p, Uri.parse(it)) }
    }

    /** Cobrança sem retorno (app fechado no meio): o operador confere no app da Stone. */
    fun resolveOrphan(approvedAtStone: Boolean) = viewModelScope.launch {
        val p = _ui.value.orphanCharge ?: return@launch
        _ui.update { it.copy(orphanCharge = null) }
        g.api.runCatching { closeCharge(p.chargeId, CloseChargeRequest("CANCELLED", message = if (approvedAtStone) "Sem retorno: estornada na maquininha" else "Sem retorno: não aprovada")) }
        edit { it.copy(pending = null) }
        if (approvedAtStone) {
            // sem o ATK: o app de cancelamento da Stone pede para escolher a transação
            ctx.startActivity(StoneDeeplink.intent(StoneDeeplink.cancelUri(null, p.amountCents)))
            say("Escolha a transação de ${Money.format(p.amountCents)} no app de cancelamento da Stone")
        }
    }

    /** Tira um pagamento antes de fechar a venda: cartão/Pix é estornado na maquininha (ATK) e só sai da venda se a Stone confirmar. */
    fun refund(payment: Payment, registerRefund: Boolean = true) = viewModelScope.launch {
        if (!payment.method.viaStone) { edit { it.copy(payments = it.payments.filterNot { p -> p.id == payment.id }) }; return@launch }
        val uri = StoneDeeplink.cancelUri(payment.atk, payment.amountCents)
        if (!StoneDeeplink.isAvailable(ctx, uri)) {
            if (BuildConfig.DEBUG && stoneSandbox) finishRefund(payment, registerRefund)
            else fail("App de cancelamento da Stone não encontrado")
            return@launch
        }
        _ui.update { it.copy(busy = "Estorno na maquininha…") }
        DeeplinkBus.consume()
        ctx.startActivity(StoneDeeplink.intent(uri))
        val back = DeeplinkBus.events.first { it.host == "cancel" }
        DeeplinkBus.consume()
        val r = StoneDeeplink.parseCancel(back)
        if (r.success) finishRefund(payment, registerRefund)
        else fail("Estorno não concluído na Stone" + (r.reason?.let { " ($it)" } ?: ""))
    }

    private suspend fun finishRefund(payment: Payment, registerRefund: Boolean) {
        if (registerRefund && payment.chargeId != null) {
            try { g.api.closeCharge(payment.chargeId, CloseChargeRequest("REFUNDED", message = "Estornado na maquininha antes de fechar a venda")) }
            catch (e: ApiException) { fail("Estornado na Stone, mas não registrado: ${e.message}"); return }
        }
        edit { it.copy(payments = it.payments.filterNot { p -> p.id == payment.id }) }
        _ui.update { it.copy(busy = null, message = "Estorno concluído: ${Money.format(payment.amountCents)}") }
    }

    // ---------- Fechamento ----------
    fun finalizeSale() = viewModelScope.launch {
        val d = _ui.value.draft
        if (d.lines.isEmpty()) { fail("Carrinho vazio"); return@launch }
        if (d.pending != null) { fail("Há uma cobrança em andamento"); return@launch }
        if (d.remainingCents > 0) { fail("Falta receber ${Money.format(d.remainingCents)}"); return@launch }
        if (d.changeCents > 0 && d.payments.none { it.method == PayMethod.CASH }) { fail("Pago acima do total sem dinheiro para troco"); return@launch }
        _ui.update { it.copy(busy = "Fechando a venda…") }
        try {
            val r = g.api.createSale(SaleRequest(
                idempotencyKey = d.idempotencyKey,
                partyId = d.party?.id,
                cpfOnInvoice = d.cpf,
                couponCode = d.coupon?.takeIf { !d.couponBelowMinimum }?.code,
                items = d.lines.map { SaleItemDto(it.variant.id, it.qty, Money.toReais(it.discountCents), if (it.discountCents > 0) (d.discountReason ?: "Desconto no PDV") else null) },
                payments = d.payments.map {
                    SalePaymentDto(it.method.api, Money.toReais(it.amountCents), it.installments, "D1", it.atk, it.authCode, it.brand, it.chargeId)
                },
            ))
            g.journal.clear()
            _ui.value = SaleUi(SaleDraft(UUID.randomUUID().toString()), finished = FinishedSale(r.orderId, r.number, Money.fromReais(r.total), d.changeCents))
        } catch (e: ApiException) { fail(e.message) }
    }

    /** Desiste da venda sem pagamento (com pagamento, é preciso estornar antes). */
    fun discard() {
        if (_ui.value.draft.locked) { fail("Estorne os pagamentos antes de cancelar a venda"); return }
        g.journal.clear()
        _ui.value = SaleUi(SaleDraft(UUID.randomUUID().toString()))
    }

    fun closeFinished() = _ui.update { it.copy(finished = null) }

    companion object {
        fun validCpf(c: String): Boolean {
            if (c.length != 11 || c.all { it == c[0] }) return false
            val d = c.map { it - '0' }
            val v1 = (0..8).sumOf { d[it] * (10 - it) }.let { (it * 10 % 11) % 10 }
            val v2 = (0..9).sumOf { d[it] * (11 - it) }.let { (it * 10 % 11) % 10 }
            return v1 == d[9] && v2 == d[10]
        }
    }
}
