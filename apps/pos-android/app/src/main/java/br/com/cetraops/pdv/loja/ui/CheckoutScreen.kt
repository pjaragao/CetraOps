package br.com.cetraops.pdv.loja.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import br.com.cetraops.pdv.loja.core.Money
import br.com.cetraops.pdv.loja.data.Operator
import br.com.cetraops.pdv.loja.sale.PayMethod
import br.com.cetraops.pdv.loja.sale.SaleUi
import br.com.cetraops.pdv.loja.sale.SaleViewModel

@Composable
private fun Section(title: String, content: @Composable () -> Unit) = Card(Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        content()
    }
}

/** Pagamento: cliente, CPF na nota, cupom, desconto e as formas (cartão e Pix pelo app da Stone; dinheiro com troco). */
@Composable
fun CheckoutScreen(ui: SaleUi, vm: SaleViewModel, operator: Operator, cashOpen: Boolean, onBack: () -> Unit) {
    val d = ui.draft
    var payDialog by remember { mutableStateOf<PayMethod?>(null) }
    var customerDialog by remember { mutableStateOf(false) }
    var discountDialog by remember { mutableStateOf(false) }
    var cpf by rememberSaveable { mutableStateOf(d.cpf.orEmpty()) }
    var coupon by rememberSaveable { mutableStateOf(d.coupon?.code.orEmpty()) }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null); Spacer(Modifier.width(4.dp)); Text("Itens") }
        }

        Section("Resumo") {
            TotalRow("Subtotal (${d.itemCount} peças)", Money.format(d.subtotalCents))
            if (d.itemDiscountCents > 0) TotalRow("Desconto" + (d.discountReason?.let { " ($it)" } ?: ""), "-" + Money.format(d.itemDiscountCents))
            d.coupon?.let { c ->
                if (d.couponBelowMinimum) TotalRow("Cupom ${c.code}", "abaixo do mínimo", color = MaterialTheme.colorScheme.error)
                else TotalRow("Cupom ${c.code}", "-" + Money.format(d.couponCents))
            }
            TotalRow("Total", Money.format(d.totalCents), strong = true)
            if (d.paidCents > 0) TotalRow("Pago", Money.format(d.paidCents))
            if (d.remainingCents > 0) TotalRow("Falta", Money.format(d.remainingCents), strong = true, color = MaterialTheme.colorScheme.primary)
            if (d.changeCents > 0) TotalRow("Troco", Money.format(d.changeCents), strong = true, color = Color(0xFF166534))
        }

        Section("Cliente") {
            if (d.party != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(d.party.name, Modifier.weight(1f), fontWeight = FontWeight.Medium)
                    if (!d.locked) TextButton(vm::clearCustomer) { Text("Tirar") }
                }
            } else OutlinedButton({ customerDialog = true }, Modifier.fillMaxWidth(), enabled = !d.locked) { Text("Identificar pelo telefone") }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(cpf, { cpf = it.filter(Char::isDigit).take(11) }, Modifier.weight(1f), singleLine = true, label = { Text("CPF na nota") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                Spacer(Modifier.width(8.dp))
                FilledTonalButton({ vm.setCpf(cpf) }) { Text(if (d.cpf != null && d.cpf == cpf) "✓" else "Usar") }
            }
        }

        Section("Cupom e desconto") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(coupon, { coupon = it.uppercase().take(40) }, Modifier.weight(1f), singleLine = true, label = { Text("Cupom") }, enabled = !d.locked,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters))
                Spacer(Modifier.width(8.dp))
                FilledTonalButton({ vm.applyCoupon(coupon) }, enabled = !d.locked) { Text(if (coupon.isBlank() && d.coupon != null) "Tirar" else "Aplicar") }
            }
            if (operator.canDiscount) OutlinedButton({ discountDialog = true }, Modifier.fillMaxWidth(), enabled = !d.locked) {
                Text(if (d.itemDiscountCents > 0) "Alterar desconto" else "Dar desconto")
            }
        }

        if (d.payments.isNotEmpty() || d.pending != null) Section("Pagamentos") {
            for (p in d.payments) Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${p.method.label}${if (p.installments > 1) " ${p.installments}x" else ""}${p.brand?.let { " · $it" } ?: ""}", fontWeight = FontWeight.Medium)
                    p.authCode?.let { Text("aut. $it", style = MaterialTheme.typography.bodyMedium) }
                }
                Text(Money.format(p.amountCents))
                TextButton({ vm.refund(p) }) { Text(if (p.method.viaStone) "Estornar" else "Tirar") }
            }
            d.pending?.let { p ->
                Text("Cobrança de ${Money.format(p.amountCents)} (${p.method.label}) aguardando registro", color = MaterialTheme.colorScheme.error)
                if (p.approvedUri != null) Button(vm::retryPending) { Text("Tentar de novo") }
            }
        }

        if (d.remainingCents > 0 && d.pending == null) Section("Receber ${Money.format(d.remainingCents)}") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ payDialog = PayMethod.CREDIT }, Modifier.weight(1f).height(52.dp)) { Text("Crédito") }
                Button({ payDialog = PayMethod.DEBIT }, Modifier.weight(1f).height(52.dp)) { Text("Débito") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ payDialog = PayMethod.PIX }, Modifier.weight(1f).height(52.dp)) { Text("Pix") }
                OutlinedButton({ payDialog = PayMethod.CASH }, Modifier.weight(1f).height(52.dp), enabled = cashOpen) { Text("Dinheiro") }
            }
            if (!cashOpen) Text("Dinheiro: abra o caixa na tela web.", style = MaterialTheme.typography.bodyMedium)
        }

        Button(vm::finalizeSale, Modifier.fillMaxWidth().height(56.dp), enabled = d.remainingCents == 0L && d.pending == null && d.lines.isNotEmpty()) {
            Text("Finalizar venda e emitir NFC-e")
        }
        if (!d.locked) TextButton(vm::discard, Modifier.fillMaxWidth()) { Text("Cancelar venda") }
    }

    payDialog?.let { m -> PayDialog(m, d.remainingCents, onDismiss = { payDialog = null }) { amount, inst ->
        payDialog = null
        if (m == PayMethod.CASH) vm.payCash(amount) else vm.payWithStone(m, amount, inst)
    } }
    if (customerDialog) CustomerDialog(onDismiss = { customerDialog = false }) { phone, name, mkt -> customerDialog = false; vm.identify(phone, name, mkt) }
    if (discountDialog) DiscountDialog(d.subtotalCents, onDismiss = { discountDialog = false }) { cents, reason -> discountDialog = false; vm.setDiscount(cents, reason) }
}

@Composable
private fun PayDialog(method: PayMethod, remaining: Long, onDismiss: () -> Unit, onConfirm: (Long, Int) -> Unit) {
    var text by remember { mutableStateOf(Money.plain(remaining)) }
    var inst by remember { mutableIntStateOf(1) }
    val cents = Money.parse(text)
    val valid = cents != null && cents > 0 && (method == PayMethod.CASH || cents <= remaining)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(method.label) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(text, { text = it }, singleLine = true, label = { Text(if (method == PayMethod.CASH) "Valor recebido" else "Valor a cobrar") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                if (method == PayMethod.CASH && cents != null && cents > remaining) Text("Troco: ${Money.format(cents - remaining)}", fontWeight = FontWeight.Bold)
                if (method != PayMethod.CASH && cents != null && cents < remaining) Text("O restante (${Money.format(remaining - cents)}) fica para outra forma.")
                if (method == PayMethod.CREDIT) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Parcelas", Modifier.weight(1f))
                    TextButton({ inst = (inst - 1).coerceAtLeast(1) }) { Text("−") }
                    Text(if (inst == 1) "à vista" else "${inst}x de ${Money.format((cents ?: 0) / inst)}")
                    TextButton({ inst = (inst + 1).coerceAtMost(12) }) { Text("+") }
                }
                if (method.viaStone) Text("A cobrança abre no app de pagamento da Stone.", style = MaterialTheme.typography.bodyMedium)
            }
        },
        confirmButton = { Button({ cents?.let { onConfirm(it, inst) } }, enabled = valid) { Text(if (method == PayMethod.CASH) "Receber" else "Cobrar") } },
        dismissButton = { TextButton(onDismiss) { Text("Voltar") } },
    )
}

@Composable
private fun CustomerDialog(onDismiss: () -> Unit, onConfirm: (String, String, Boolean) -> Unit) {
    var phone by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var mkt by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Cliente") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(phone, { phone = it.filter(Char::isDigit).take(13) }, singleLine = true, label = { Text("Telefone com DDD") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))
                OutlinedTextField(name, { name = it.take(120) }, singleLine = true, label = { Text("Nome (se for cadastro novo)") })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(mkt, { mkt = it })
                    Text("Aceita receber novidades no WhatsApp")
                }
            }
        },
        confirmButton = { Button({ onConfirm(phone, name, mkt) }, enabled = phone.length >= 10) { Text("Buscar") } },
        dismissButton = { TextButton(onDismiss) { Text("Voltar") } },
    )
}

@Composable
private fun DiscountDialog(subtotal: Long, onDismiss: () -> Unit, onConfirm: (Long, String) -> Unit) {
    var text by remember { mutableStateOf("") }
    var percent by remember { mutableStateOf(true) }
    var reason by remember { mutableStateOf("") }
    val cents: Long? = if (percent) text.replace(',', '.').toDoubleOrNull()?.takeIf { it in 0.0..100.0 }?.let { Math.round(subtotal * it / 100) }
                       else Money.parse(text)?.takeIf { it <= subtotal }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Desconto na venda") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (percent) Button({}) { Text("%") } else OutlinedButton({ percent = true }) { Text("%") }
                    if (!percent) Button({}) { Text("R$") } else OutlinedButton({ percent = false }) { Text("R$") }
                }
                OutlinedTextField(text, { text = it }, singleLine = true, label = { Text(if (percent) "Percentual" else "Valor") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                cents?.let { Text("Desconto: ${Money.format(it)} · total ${Money.format(subtotal - it)}") }
                OutlinedTextField(reason, { reason = it.take(200) }, singleLine = true, label = { Text("Motivo") })
            }
        },
        confirmButton = { Button({ cents?.let { onConfirm(it, reason) } }, enabled = cents != null && reason.isNotBlank()) { Text("Aplicar") } },
        dismissButton = { TextButton({ onConfirm(0, "") }) { Text("Sem desconto") } },
    )
}
