package br.com.cetraops.pdv.loja.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import br.com.cetraops.pdv.loja.core.Money
import br.com.cetraops.pdv.loja.data.CatalogStore
import br.com.cetraops.pdv.loja.data.PosProduct
import br.com.cetraops.pdv.loja.sale.SaleUi
import br.com.cetraops.pdv.loja.sale.SaleViewModel
import br.com.cetraops.pdv.loja.scan.BarcodeScanner

/** Carrinho: câmera lendo código de barras, busca por nome/referência/SKU (leitor USB/teclado também entra aqui) e itens. */
@Composable
fun CartScreen(ui: SaleUi, vm: SaleViewModel, catalog: CatalogStore, onCheckout: () -> Unit) {
    val context = LocalContext.current
    var scanning by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> scanning = ok }
    val d = ui.draft

    Column(Modifier.fillMaxSize()) {
        if (scanning) {
            Surface(Modifier.fillMaxWidth().height(200.dp)) {
                BarcodeScanner(Modifier.fillMaxSize()) { code -> vm.scanned(code) }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                query, { query = it }, Modifier.weight(1f), singleLine = true,
                placeholder = { Text("Código, referência ou nome") },
                leadingIcon = { Icon(Icons.Default.Search, null) },
                trailingIcon = { if (query.isNotEmpty()) IconButton({ query = "" }) { Icon(Icons.Default.Close, "Limpar") } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                // Enter (teclado ou leitor de código USB): procura o código exato
                keyboardActions = KeyboardActions(onSearch = {
                    if (catalog.lookup(query) !is CatalogStore.Lookup.NotFound) { vm.scanned(query); query = "" }
                }),
            )
            Spacer(Modifier.width(8.dp))
            FilledTonalButton(onClick = {
                if (scanning) scanning = false
                else if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
                else askCamera.launch(Manifest.permission.CAMERA)
            }) { Icon(Icons.Default.QrCodeScanner, null); Spacer(Modifier.width(4.dp)); Text(if (scanning) "Parar" else "Ler") }
        }

        if (query.isNotBlank()) {
            val results = remember(query, catalog.products) { catalog.search(query) }
            LazyColumn(Modifier.weight(1f)) {
                if (results.isEmpty()) item { Text("Nada encontrado", Modifier.padding(16.dp)) }
                items(results, key = { it.key }) { p -> ProductRow(p) { vm.pick(listOf(p)) } }
            }
        } else {
            LazyColumn(Modifier.weight(1f)) {
                if (d.lines.isEmpty()) item {
                    Centered {
                        Text("Leia o código de barras da etiqueta ou busque a peça.", style = MaterialTheme.typography.bodyLarge)
                        Text("${catalog.products.size} produtos no catálogo da loja", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                items(d.lines, key = { it.id }) { l ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(l.title, maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                            Text("${l.variant.sku} · ${Money.format(l.unitCents)}" + if (l.discountCents > 0) " · desc. ${Money.format(l.discountCents)}" else "",
                                style = MaterialTheme.typography.bodyMedium)
                        }
                        if (!d.locked) {
                            IconButton({ vm.changeQty(l.id, -1) }) { Icon(if (l.qty == 1) Icons.Default.Delete else Icons.Default.Remove, "Menos") }
                        }
                        Text("${l.qty}", style = MaterialTheme.typography.titleMedium)
                        if (!d.locked) IconButton({ vm.changeQty(l.id, 1) }) { Icon(Icons.Default.Add, "Mais") }
                        Text(Money.format(l.grossCents - l.discountCents), Modifier.width(92.dp), fontWeight = FontWeight.SemiBold, maxLines = 1)
                    }
                    HorizontalDivider()
                }
            }
        }

        Surface(tonalElevation = 3.dp, color = MaterialTheme.colorScheme.surfaceVariant) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${d.itemCount} ${if (d.itemCount == 1) "peça" else "peças"}", style = MaterialTheme.typography.bodyMedium)
                    Text(Money.format(d.totalCents), style = MaterialTheme.typography.titleLarge)
                }
                if (d.lines.isNotEmpty() && !d.locked) TextButton(vm::discard) { Text("Cancelar") }
                Button(onCheckout, enabled = d.lines.isNotEmpty(), modifier = Modifier.height(52.dp)) { Text(if (d.locked) "Continuar pagamento" else "Pagamento") }
            }
        }
    }

    ui.picking?.let { products -> VariantPicker(products, onPick = { p, v -> vm.add(p, v) }, onDismiss = { vm.pick(null) }) }
}

@Composable
private fun ProductRow(p: PosProduct, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Text(listOf(p.name, p.color.ifBlank { null }).filterNotNull().joinToString(" · "), fontWeight = FontWeight.Medium)
        val price = p.variants.minOfOrNull { it.price } ?: 0.0
        val stock = p.variants.sumOf { it.available }.toInt()
        Text("Ref. ${p.reference} · ${Money.format(Money.fromReais(price))} · $stock em estoque", style = MaterialTheme.typography.bodyMedium)
    }
    HorizontalDivider()
}

/** Escolha de cor/tamanho (código da referência, ou peça achada pela busca). */
@Composable
fun VariantPicker(products: List<PosProduct>, onPick: (PosProduct, br.com.cetraops.pdv.loja.data.PosVariant) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onDismiss) { Text("Fechar") } },
        title = { Text(products.first().name) },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (p in products) {
                    if (p.color.isNotBlank()) item { Text(p.color, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp)) }
                    items(p.variants, key = { it.id }) { v ->
                        val ok = v.available >= 1
                        Row(
                            Modifier.fillMaxWidth()
                                .background(if (ok) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface)
                                .clickable(enabled = ok) { onPick(p, v) }.padding(12.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(v.size, fontWeight = FontWeight.Bold)
                            Text(if (ok) "${v.available.toInt()} em estoque" else "sem estoque")
                            Text(Money.format(Money.fromReais(v.price)))
                        }
                    }
                }
            }
        },
    )
}
