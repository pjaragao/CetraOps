package br.com.cetraops.pdv.loja.data

import br.com.cetraops.pdv.loja.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class ApiException(message: String, val status: Int) : Exception(message)

/**
 * Cliente da API /api/pos do CetraOps. Todo pedido leva o token da maquininha; depois do login, também o JWT do operador
 * (renovado sozinho quando está para vencer ou quando o servidor responde 401).
 */
class PosApi(private val store: SecureStore) {
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(40, TimeUnit.SECONDS).writeTimeout(20, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val refreshLock = Mutex()

    /** Chamado quando a sessão do operador não pode mais ser renovada (volta para o login). */
    var onSessionLost: (() -> Unit)? = null
    /** Chamado quando a maquininha foi desativada no sistema (volta para o pareamento). */
    var onDeviceRevoked: (() -> Unit)? = null

    private fun base(): String = (store.serverUrl ?: throw ApiException("Servidor não configurado", 0)).trimEnd('/')

    // ---------- Pareamento e sessão ----------
    suspend fun pair(serverUrl: String, code: String, serial: String?, model: String?): PairResponse {
        val body = json.encodeToString(PairRequest.serializer(), PairRequest(code, serial, model, BuildConfig.VERSION_NAME))
        val req = Request.Builder().url("${serverUrl.trimEnd('/')}/api/pos/pair").post(body.toRequestBody(jsonType)).build()
        return json.decodeFromString(PairResponse.serializer(), execute(req))
    }

    suspend fun login(email: String, password: String): SessionTokens {
        val body = json.encodeToString(LoginRequest.serializer(), LoginRequest(email, password))
        val tokens = json.decodeFromString(SessionTokens.serializer(), execute(deviceRequest("/api/pos/auth/login").post(body.toRequestBody(jsonType)).build()))
        store.session = tokens
        return tokens
    }

    fun logout() { store.session = null }

    // ---------- Dados ----------
    suspend fun bootstrap(): Bootstrap = get("/api/pos/bootstrap", Bootstrap.serializer())

    /** Catálogo com ETag: devolve null quando não mudou desde a última vez. */
    suspend fun catalog(etag: String?): Pair<CatalogResponse, String?>? = withAuth { token ->
        val b = deviceRequest("/api/pos/catalog").get().header("Authorization", "Bearer $token")
        if (etag != null) b.header("If-None-Match", etag)
        withContext(Dispatchers.IO) {
            http.newCall(b.build()).execute().use { res ->
                if (res.code == 304) return@withContext null
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw toError(res.code, text)
                json.decodeFromString(CatalogResponse.serializer(), text) to res.header("ETag")
            }
        }
    }

    suspend fun customer(req: CustomerRequest) = post("/api/pos/customers", req, CustomerRequest.serializer(), CustomerResponse.serializer())
    suspend fun coupon(code: String) = get("/api/pos/coupons/${URLEncoder.encode(code, "UTF-8")}", Coupon.serializer())
    suspend fun openCharge(req: OpenChargeRequest) = post("/api/pos/charges", req, OpenChargeRequest.serializer(), OpenChargeResponse.serializer())
    suspend fun confirmCharge(id: String, req: ConfirmChargeRequest) =
        post("/api/pos/charges/$id/confirm", req, ConfirmChargeRequest.serializer(), ConfirmChargeResponse.serializer())
    suspend fun closeCharge(id: String, req: CloseChargeRequest) {
        post("/api/pos/charges/$id/close", req, CloseChargeRequest.serializer(), kotlinx.serialization.json.JsonElement.serializer())
    }
    suspend fun createSale(req: SaleRequest) = post("/api/pos/sales", req, SaleRequest.serializer(), SaleResponse.serializer())
    suspend fun todaySales() = get("/api/pos/sales", SalesList.serializer())
    suspend fun receipt(orderId: String) = get("/api/pos/sales/$orderId", ReceiptResponse.serializer())

    // ---------- Infra ----------
    private fun deviceRequest(path: String): Request.Builder {
        val b = Request.Builder().url(base() + path).header("X-App-Version", BuildConfig.VERSION_NAME)
        store.deviceToken?.let { b.header("X-Device-Token", it) }
        return b
    }

    private suspend fun <T> get(path: String, out: kotlinx.serialization.KSerializer<T>): T = withAuth { token ->
        json.decodeFromString(out, execute(deviceRequest(path).get().header("Authorization", "Bearer $token").build()))
    }

    private suspend fun <I, T> post(path: String, body: I, inS: kotlinx.serialization.KSerializer<I>, out: kotlinx.serialization.KSerializer<T>): T = withAuth { token ->
        val req = deviceRequest(path).post(json.encodeToString(inS, body).toRequestBody(jsonType)).header("Authorization", "Bearer $token").build()
        json.decodeFromString(out, execute(req))
    }

    /** Executa com o JWT válido; se o servidor disser 401, renova uma vez e tenta de novo. */
    private suspend fun <T> withAuth(block: suspend (String) -> T): T {
        val token = freshToken()
        return try {
            block(token)
        } catch (e: ApiException) {
            if (e.status != 401) throw e
            if (e.message?.contains("Maquininha", ignoreCase = true) == true) { onDeviceRevoked?.invoke(); throw e }
            block(refresh(force = true))
        }
    }

    private suspend fun freshToken(): String {
        val s = store.session ?: run { onSessionLost?.invoke(); throw ApiException("Entre com o seu usuário", 401) }
        val now = System.currentTimeMillis() / 1000
        return if (s.expiresAt - now < 60) refresh(force = false) else s.accessToken
    }

    private suspend fun refresh(force: Boolean): String = refreshLock.withLock {
        val s = store.session ?: run { onSessionLost?.invoke(); throw ApiException("Entre com o seu usuário", 401) }
        val now = System.currentTimeMillis() / 1000
        if (!force && s.expiresAt - now >= 60) return@withLock s.accessToken
        try {
            val body = json.encodeToString(RefreshRequest.serializer(), RefreshRequest(s.refreshToken))
            val t = json.decodeFromString(SessionTokens.serializer(), execute(deviceRequest("/api/pos/auth/refresh").post(body.toRequestBody(jsonType)).build()))
            store.session = t
            t.accessToken
        } catch (e: ApiException) {
            if (e.status == 401 || e.status == 403) { store.session = null; onSessionLost?.invoke() }
            throw e
        }
    }

    private suspend fun execute(req: Request): String = withContext(Dispatchers.IO) {
        try {
            http.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw toError(res.code, text)
                text
            }
        } catch (e: IOException) {
            throw ApiException("Sem conexão com o servidor. Confira a internet da maquininha.", 0)
        }
    }

    private fun toError(code: Int, text: String): ApiException {
        val msg = runCatching { json.decodeFromString(ApiError.serializer(), text).error }.getOrNull()
        return ApiException(msg ?: "Erro do servidor ($code)", code)
    }
}
