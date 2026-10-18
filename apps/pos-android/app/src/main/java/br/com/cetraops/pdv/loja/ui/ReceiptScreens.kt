package br.com.cetraops.pdv.loja.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import br.com.cetraops.pdv.loja.core.Money
import br.com.cetraops.pdv.loja.data.SaleSummary
import br.com.cetraops.pdv.loja.print.ReceiptUi
import br.com.cetraops.pdv.loja.print.ReceiptViewModel
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val fiscalLabel = mapOf(
    "DRAFT" to "na fila", "PROCESSING" to "na SEFAZ", "AUTHORIZED" to "autorizada", "REJECTED" to "rejeitada", "DENIED" to "denegada",
    "CANCELLED" to "cancelada", "CONTINGENCY_PENDING" to "em contingência", "NUMBER_VOIDED" to "numeração inutilizada",
)

@Composable
private fun ReceiptActions(r: ReceiptUi, vm: ReceiptViewModel) {
    val fiscal = r.data?.fiscal
    Text(
        when {
            r.waitingNfce -> "NFC-e: aguardando a SEFAZ…"
            fiscal == null -> "NFC-e: ainda não gerada"
            else -> "NFC-e ${fiscalLabel[fiscal.status] ?: fiscal.status}"
        },
        fontWeight = FontWeight.Medium,
    )
    r.message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    if (r.waitingNfce || r.printing) CircularProgressIndicator()
    Button(vm::printNfce, Modifier.fillMaxWidth().height(52.dp), enabled = fiscal?.nfce?.danfe != null && !r.printing) { Text("Imprimir NFC-e") }
    OutlinedButton(vm::printReceipt, Modifier.fillMaxWidth(), enabled = r.data != null && !r.printing) { Text("Imprimir comprovante (não fiscal)") }
    if (!r.waitingNfce && fiscal?.nfce?.danfe == null) TextButton(vm::reload) { Text("Consultar a NFC-e de novo") }
}

/** Venda fechada: troco, NFC-e (imprime sozinha quando a SEFAZ autoriza, se ligado em Ajustes) e nova venda. */
@Composable
fun DoneScreen(number: String, totalCents: Long, changeCents: Long, r: ReceiptUi, vm: ReceiptViewModel, onNew: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Venda $number concluída", style = MaterialTheme.typography.titleLarge)
        Text(Money.format(totalCents), style = MaterialTheme.typography.titleLarge)
        if (changeCents > 0) Text("Troco: ${Money.format(changeCents)}", style = MaterialTheme.typography.titleLarge, color = Color(0xFF166534))
        ReceiptActions(r, vm)
        Button(onNew, Modifier.fillMaxWidth().height(56.dp)) { Text("Nova venda") }
    }
}

private val hour = DateTimeFormatter.ofPattern("HH:mm")
private fun hhmm(iso: String) = runCatching { OffsetDateTime.parse(iso).atZoneSameInstant(ZoneId.of("America/Sao_Paulo")).format(hour) }.getOrDefault("")

@Composable
fun TodaySales(sales: List<SaleSummary>?, onLoad: () -> Unit, onOpen: (SaleSummary) -> Unit) {
    LaunchedEffect(Unit) { onLoad() }
    if (sales == null) { Centered { CircularProgressIndicator() }; return }
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("${sales.size} vendas · ${Money.format(sales.filter { it.status != "CANCELLED" }.sumOf { Money.fromReais(it.total) })}", style = MaterialTheme.typography.titleMedium)
                TextButton(onLoad) { Text("Atualizar") }
            }
        }
        items(sales, key = { it.id }) { s ->
            Row(Modifier.fillMaxWidth().clickable { onOpen(s) }.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("${hhmm(s.createdAt)} · ${s.number}", fontWeight = FontWeight.Medium)
                    Text(s.customer ?: "Cliente não identificada", style = MaterialTheme.typography.bodyMedium)
                }
                Text(Money.format(Money.fromReais(s.total)), color = if (s.status == "CANCELLED") MaterialTheme.colorScheme.error else Color.Unspecified)
            }
            HorizontalDivider()
        }
    }
}

@Composable
fun SaleDetail(s: SaleSummary, r: ReceiptUi, vm: ReceiptViewModel, onBack: () -> Unit) {
    LaunchedEffect(s.id) { vm.open(s.id, autoPrint = false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onBack) { Text("← Vendas de hoje") }
        Text("Venda ${s.number}", style = MaterialTheme.typography.titleLarge)
        r.data?.order?.let { o ->
            for (i in o.items) TotalRow("${i.qty.toInt()}× ${i.name}", Money.format(Money.fromReais(i.total)))
            HorizontalDivider()
            TotalRow("Total", Money.format(Money.fromReais(o.total)), strong = true)
            for (p in o.payments) TotalRow(p.label, Money.format(Money.fromReais(p.amount)))
        }
        ReceiptActions(r, vm)
    }
}
