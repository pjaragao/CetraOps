package br.com.cetraops.pdv.loja.sale

import android.content.Context
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Venda em andamento gravada a cada mudança: se o terminal reiniciar ou o Android fechar o app enquanto o cliente paga no app da Stone,
 * a venda (e a cobrança pendente) volta igual.
 */
class SaleJournal(context: Context, private val json: Json) {
    private val file = File(context.filesDir, "sale-draft.json")
    private val tmp = File(context.filesDir, "sale-draft.json.tmp")

    fun load(): SaleDraft? = runCatching { if (file.exists()) json.decodeFromString(SaleDraft.serializer(), file.readText()) else null }.getOrNull()

    fun save(d: SaleDraft) {
        tmp.writeText(json.encodeToString(SaleDraft.serializer(), d))
        tmp.renameTo(file)
    }

    fun clear() { file.delete() }
}
