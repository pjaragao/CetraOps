package br.com.cetraops.pdv.loja.data

import android.content.Context
import kotlinx.serialization.json.Json
import java.io.File
import java.text.Normalizer

/** Peça encontrada no catálogo (uma variante = produto + cor + tamanho). */
data class CatalogHit(val product: PosProduct, val variant: PosVariant)

/**
 * Catálogo da loja guardado no aparelho (busca instantânea e funciona com a rede instável); atualizado pelo ETag a cada abertura.
 * Índice por GTIN/EAN (sem zeros à esquerda), SKU e referência.
 */
class CatalogStore(context: Context, private val json: Json) {
    private val file = File(context.filesDir, "catalog.json")
    private val etagFile = File(context.filesDir, "catalog.etag")

    var products: List<PosProduct> = emptyList(); private set
    private var byCode: Map<String, CatalogHit> = emptyMap()
    private var byReference: Map<String, List<PosProduct>> = emptyMap()

    val etag: String? get() = etagFile.takeIf { it.exists() }?.readText()?.ifBlank { null }

    fun loadCached(): Boolean = runCatching {
        if (!file.exists()) return false
        set(json.decodeFromString(CatalogResponse.serializer(), file.readText()).products)
        true
    }.getOrDefault(false)

    fun save(resp: CatalogResponse, newEtag: String?) {
        file.writeText(json.encodeToString(CatalogResponse.serializer(), resp))
        etagFile.writeText(newEtag ?: "")
        set(resp.products)
    }

    fun clear() { file.delete(); etagFile.delete(); set(emptyList()) }

    private fun set(list: List<PosProduct>) {
        products = list
        val codes = HashMap<String, CatalogHit>()
        val refs = HashMap<String, MutableList<PosProduct>>()
        for (p in list) {
            refs.getOrPut(norm(p.reference)) { mutableListOf() } += p
            for (v in p.variants) {
                v.gtin?.let { g -> codes[gtinKey(g)] = CatalogHit(p, v) }
                codes[norm(v.sku)] = CatalogHit(p, v)
            }
        }
        byCode = codes
        byReference = refs
    }

    sealed interface Lookup {
        data class One(val hit: CatalogHit) : Lookup
        /** Código da referência (sem tamanho): escolher cor/tamanho. */
        data class Pick(val products: List<PosProduct>) : Lookup
        data object NotFound : Lookup
    }

    fun lookup(code: String): Lookup {
        val c = code.trim()
        if (c.isEmpty()) return Lookup.NotFound
        byCode[gtinKey(c)]?.let { return Lookup.One(it) }
        byCode[norm(c)]?.let { return Lookup.One(it) }
        byReference[norm(c)]?.let { return Lookup.Pick(it) }
        return Lookup.NotFound
    }

    fun search(text: String, limit: Int = 60): List<PosProduct> {
        val q = fold(text)
        if (q.isBlank()) return products.take(limit)
        val terms = q.split(' ').filter { it.isNotBlank() }
        return products.filter { p ->
            val hay = fold("${p.name} ${p.reference} ${p.color} ${p.variants.joinToString(" ") { it.sku }}")
            terms.all { hay.contains(it) }
        }.take(limit)
    }

    companion object {
        private fun norm(s: String) = s.trim().uppercase()
        private fun gtinKey(s: String) = s.trim().trimStart('0').ifEmpty { "0" }.let { if (it.all(Char::isDigit)) "#$it" else norm(it) }
        fun fold(s: String) = Normalizer.normalize(s.lowercase(), Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")
    }
}
