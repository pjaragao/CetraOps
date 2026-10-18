package br.com.cetraops.pdv.loja.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** Faixa de aviso (sucesso some sozinho em 3 s; erro fica até tocar). */
@Composable
fun Banner(message: String?, error: String?, onDismiss: () -> Unit) {
    val text = error ?: message ?: return
    val isError = error != null
    if (!isError) LaunchedEffect(text) { delay(3_000); onDismiss() }
    Surface(
        color = if (isError) Color(0xFFFEE2E2) else Color(0xFFDCFCE7),
        contentColor = if (isError) Color(0xFF991B1B) else Color(0xFF166534),
        modifier = Modifier.fillMaxWidth(),
        onClick = onDismiss,
    ) { Text(text, Modifier.padding(horizontal = 16.dp, vertical = 10.dp), style = MaterialTheme.typography.bodyMedium) }
}

@Composable
fun BusyOverlay(text: String?, action: Pair<String, () -> Unit>? = null) {
    if (text == null) return
    AlertDialog(
        onDismissRequest = {},
        confirmButton = { action?.let { (label, f) -> TextButton(onClick = f) { Text(label) } } },
        text = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                CircularProgressIndicator(Modifier.size(28.dp))
                Text(text)
            }
        },
    )
}

@Composable
fun TotalRow(label: String, value: String, strong: Boolean = false, color: Color = Color.Unspecified) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = if (strong) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium, color = color)
        Text(value, style = if (strong) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium, fontWeight = if (strong) FontWeight.Bold else null, color = color)
    }
}

@Composable
fun Centered(content: @Composable () -> Unit) = Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) { content() }
}
