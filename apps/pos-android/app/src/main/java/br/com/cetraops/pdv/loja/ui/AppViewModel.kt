package br.com.cetraops.pdv.loja.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import br.com.cetraops.pdv.loja.PdvApp
import br.com.cetraops.pdv.loja.data.ApiException
import br.com.cetraops.pdv.loja.data.Bootstrap
import br.com.cetraops.pdv.loja.data.SaleSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class Stage { PAIRING, LOGIN, LOADING, READY }

data class AppUi(
    val stage: Stage,
    val serverUrl: String = "",
    val deviceName: String? = null,
    val storeName: String? = null,
    val lastEmail: String = "",
    val boot: Bootstrap? = null,
    val catalogCount: Int = 0,
    val catalogUpdating: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val todaySales: List<SaleSummary>? = null,
)

/** Pareamento da maquininha, login do operador, abertura (caixa, permissões) e catálogo. */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val g = app as PdvApp
    private val _ui = MutableStateFlow(initial())
    val ui: StateFlow<AppUi> = _ui.asStateFlow()

    init {
        g.api.onSessionLost = { _ui.update { it.copy(stage = if (g.store.deviceToken == null) Stage.PAIRING else Stage.LOGIN, boot = null) } }
        g.api.onDeviceRevoked = { g.store.unpair(); g.catalog.clear(); _ui.update { initial().copy(error = "Esta maquininha foi desativada no sistema. Pareie de novo.") } }
        g.catalog.loadCached()
        if (_ui.value.stage == Stage.LOADING) open()
    }

    private fun initial(): AppUi {
        val s = g.store
        val stage = when {
            s.deviceToken == null -> Stage.PAIRING
            s.session == null -> Stage.LOGIN
            else -> Stage.LOADING
        }
        return AppUi(stage, s.serverUrl.orEmpty(), s.deviceName, s.storeName, s.lastEmail.orEmpty(), catalogCount = g.catalog.products.size)
    }

    fun pair(serverUrl: String, code: String) = viewModelScope.launch {
        val url = serverUrl.trim().trimEnd('/').let { if (it.startsWith("http")) it else "https://$it" }
        if (!url.startsWith("https://")) { _ui.update { it.copy(error = "O endereço precisa ser HTTPS") }; return@launch }
        _ui.update { it.copy(busy = true, error = null) }
        try {
            @Suppress("DEPRECATION")
            val serial = runCatching { Build.SERIAL }.getOrNull()?.takeIf { it != Build.UNKNOWN }
            val r = g.api.pair(url, code, serial, "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            g.store.serverUrl = url
            g.store.deviceToken = r.deviceToken
            g.store.deviceName = r.device.name
            g.store.storeName = r.device.storeName
            g.catalog.clear()
            _ui.update { it.copy(stage = Stage.LOGIN, busy = false, serverUrl = url, deviceName = r.device.name, storeName = r.device.storeName) }
        } catch (e: ApiException) { _ui.update { it.copy(busy = false, error = e.message) } }
    }

    fun login(email: String, password: String) = viewModelScope.launch {
        _ui.update { it.copy(busy = true, error = null) }
        try {
            g.api.login(email.trim(), password)
            g.store.lastEmail = email.trim()
            _ui.update { it.copy(busy = false, lastEmail = email.trim()) }
            open()
        } catch (e: ApiException) { _ui.update { it.copy(busy = false, error = e.message) } }
    }

    fun open() = viewModelScope.launch {
        _ui.update { it.copy(stage = Stage.LOADING, error = null) }
        try {
            val boot = g.api.bootstrap()
            _ui.update { it.copy(stage = Stage.READY, boot = boot, storeName = boot.store.name, deviceName = boot.device.name) }
            refreshCatalog()
        } catch (e: ApiException) {
            // sem rede com catálogo guardado: não dá para cobrar (a cobrança passa pelo servidor), então fica na tela de abertura com o erro
            _ui.update { it.copy(stage = if (e.status == 401) Stage.LOGIN else Stage.LOADING, error = e.message) }
        }
    }

    fun refreshCatalog() = viewModelScope.launch {
        _ui.update { it.copy(catalogUpdating = true) }
        try {
            g.api.catalog(g.catalog.etag)?.let { (resp, etag) -> g.catalog.save(resp, etag) }
            _ui.update { it.copy(catalogUpdating = false, catalogCount = g.catalog.products.size) }
        } catch (e: ApiException) {
            _ui.update { it.copy(catalogUpdating = false, error = "Catálogo não atualizado: ${e.message}") }
        }
    }

    fun loadToday() = viewModelScope.launch {
        try { _ui.update { it.copy(todaySales = g.api.todaySales().sales) } }
        catch (e: ApiException) { _ui.update { it.copy(error = e.message) } }
    }

    fun logout() {
        g.api.logout()
        _ui.update { it.copy(stage = Stage.LOGIN, boot = null) }
    }

    /** Desfaz o pareamento neste aparelho (o sócio também pode desativar pelo sistema). */
    fun unpair() {
        g.store.unpair()
        g.catalog.clear()
        g.journal.clear()
        _ui.value = initial()
    }

    fun clearError() = _ui.update { it.copy(error = null) }
}
