package br.com.cetraops.pdv.loja.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
private fun SetupColumn(content: @Composable () -> Unit) = Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
) { content() }

/** 1ª abertura: endereço do sistema e o código gerado pelo sócio em Configurações › Integrações › Stone › App do PDV. */
@Composable
fun PairingScreen(ui: AppUi, onPair: (String, String) -> Unit, onContact: () -> Unit) = SetupColumn {
    var url by rememberSaveable { mutableStateOf(ui.serverUrl) }
    var code by rememberSaveable { mutableStateOf("") }
    Spacer(Modifier.height(24.dp))
    Text("Parear maquininha", style = MaterialTheme.typography.titleLarge)
    Text("No sistema, o sócio abre Configurações › Integrações › Stone › App do PDV na maquininha e gera um código de 8 letras e números (vale 15 minutos).")
    OutlinedTextField(url, { url = it.trim() }, Modifier.fillMaxWidth(), label = { Text("Endereço do sistema (https://…)") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next))
    OutlinedTextField(code, { code = it.uppercase().take(9) }, Modifier.fillMaxWidth(), label = { Text("Código de pareamento") }, singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onPair(url, code) }))
    ui.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    Button({ onPair(url, code) }, Modifier.fillMaxWidth().height(52.dp), enabled = !ui.busy && url.isNotBlank() && code.count(Char::isLetterOrDigit) == 8) {
        if (ui.busy) CircularProgressIndicator(color = MaterialTheme.colorScheme.onPrimary) else Text("Parear")
    }
    TextButton(onContact) { Text("Fale conosco") }
}

@Composable
fun LoginScreen(ui: AppUi, onLogin: (String, String) -> Unit, onUnpair: () -> Unit, onContact: () -> Unit) = SetupColumn {
    var email by rememberSaveable { mutableStateOf(ui.lastEmail) }
    var pass by rememberSaveable { mutableStateOf("") }
    Spacer(Modifier.height(24.dp))
    Text(ui.storeName ?: "Loja", style = MaterialTheme.typography.titleLarge)
    Text("Maquininha: ${ui.deviceName ?: "—"}", style = MaterialTheme.typography.bodyMedium)
    Text("Entre com o seu usuário do sistema. A venda fica no seu nome.")
    OutlinedTextField(email, { email = it.trim() }, Modifier.fillMaxWidth(), label = { Text("E-mail") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next))
    OutlinedTextField(pass, { pass = it }, Modifier.fillMaxWidth(), label = { Text("Senha") }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onLogin(email, pass) }))
    ui.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    Button({ onLogin(email, pass) }, Modifier.fillMaxWidth().height(52.dp), enabled = !ui.busy && email.isNotBlank() && pass.isNotBlank()) {
        if (ui.busy) CircularProgressIndicator(color = MaterialTheme.colorScheme.onPrimary) else Text("Entrar")
    }
    TextButton(onContact) { Text("Fale conosco") }
    OutlinedButton(onUnpair, Modifier.fillMaxWidth()) { Text("Desfazer pareamento deste aparelho") }
}

@Composable
fun LoadingScreen(ui: AppUi, onRetry: () -> Unit, onLogout: () -> Unit) = SetupColumn {
    Spacer(Modifier.height(48.dp))
    Centered {
        if (ui.error == null) { CircularProgressIndicator(); Text("Abrindo a loja…") }
        else {
            Text(ui.error, color = MaterialTheme.colorScheme.error)
            Button(onRetry) { Text("Tentar de novo") }
            TextButton(onLogout) { Text("Trocar de usuário") }
        }
    }
}
