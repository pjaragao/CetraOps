package br.com.cetraops.pdv.loja.print

import android.graphics.Bitmap
import android.graphics.Color
import android.util.Base64
import br.com.cetraops.pdv.loja.core.Money
import br.com.cetraops.pdv.loja.data.Danfe
import br.com.cetraops.pdv.loja.data.ReceiptOrder
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import java.io.ByteArrayOutputStream
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Monta o conteúdo de impressão no formato do Deeplink de impressão da Stone (lista de {type: text|line|image}).
 * Cada bloco vai numa chamada separada (a Stone pede uma imagem por chamada, em sequência).
 * Layout do DANFE NFC-e segue o Manual do DANFE NFC-e (mesmas divisões da página /imprimir/nfce do sistema).
 */
class Receipts(private val columns: Int) {
    sealed interface Block { val json: String }
    class TextBlock(val lines: List<Line>) : Block {
        override val json: String get() = buildJsonArray {
            for (l in lines) add(buildJsonObject {
                put("type", JsonPrimitive("text")); put("content", JsonPrimitive(l.text.ifEmpty { " " }))
                put("align", JsonPrimitive(l.align)); put("size", JsonPrimitive(l.size))
            })
        }.toString()
    }
    class ImageBlock(private val base64Png: String) : Block {
        override val json: String get() = JsonArray(listOf(buildJsonObject { put("type", JsonPrimitive("image")); put("imagePath", JsonPrimitive(base64Png)) })).toString()
    }
    data class Line(val text: String, val align: String = "left", val size: String = "small")

    private val br = Locale("pt", "BR")
    private val whenFmt = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm:ss", br)
    private fun whenBr(iso: String?): String = runCatching { OffsetDateTime.parse(iso).atZoneSameInstant(ZoneId.of("America/Sao_Paulo")).format(whenFmt) }.getOrDefault(iso ?: "—")
    private fun money(s: String): String = Money.plain(Money.fromReais(s.toDoubleOrNull() ?: 0.0))
    private val sep get() = Line("-".repeat(columns))

    private fun center(t: String, size: String = "small") = wrap(t).map { Line(it, "center", size) }
    private fun lr(left: String, right: String): Line {
        val space = columns - right.length - 1
        val l = if (left.length > space) left.take(maxOf(space, 0)) else left
        return Line(l + " ".repeat(maxOf(1, columns - l.length - right.length)) + right)
    }
    private fun wrap(t: String, width: Int = columns): List<String> {
        if (t.length <= width) return listOf(t)
        val out = mutableListOf<String>()
        var cur = StringBuilder()
        for (w in t.split(' ')) {
            if (cur.isNotEmpty() && cur.length + 1 + w.length > width) { out += cur.toString(); cur = StringBuilder() }
            if (w.length > width) { w.chunked(width).forEach { if (cur.isNotEmpty()) { out += cur.toString(); cur = StringBuilder() }; cur.append(it) } }
            else { if (cur.isNotEmpty()) cur.append(' '); cur.append(w) }
        }
        if (cur.isNotEmpty()) out += cur.toString()
        return out
    }
    private fun cnpj(c: String) = c.replace(Regex("^(\\d{2})(\\d{3})(\\d{3})(\\d{4})(\\d{2})$"), "$1.$2.$3/$4-$5")
    private fun cpf(c: String) = c.replace(Regex("^(\\d{3})(\\d{3})(\\d{3})(\\d{2})$"), "$1.$2.$3-$4")

    /** DANFE NFC-e: divisões I a VII, com o QR Code como imagem entre os textos. */
    fun danfe(d: Danfe, cancelled: Boolean): List<Block> {
        val top = mutableListOf<Line>()
        if (cancelled) top += center("NFC-e CANCELADA", "medium")
        top += center(d.emit.razao_social, "medium")
        top += center("CNPJ ${cnpj(d.emit.cnpj)}" + (d.emit.ie?.let { " IE $it" } ?: ""))
        top += center(d.emit.endereco)
        top += sep
        top += center("DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica")
        top += sep
        top += Line("Código Descrição")
        top += lr("Qtde Un x Vl Unit", "Vl Total")
        for (i in d.items) {
            wrap("${i.codigo} ${i.descricao}").forEach { top += Line(it) }
            top += lr("  ${i.qtd} ${i.un} x ${money(i.vun)}", money(i.vtot))
        }
        top += sep
        top += lr("Qtde. total de itens", d.items.size.toString())
        top += lr("Valor total R$", money(d.vProd))
        if ((d.vDesc.toDoubleOrNull() ?: 0.0) > 0) top += lr("Desconto R$", money(d.vDesc))
        val acr = (d.vFrete.toDoubleOrNull() ?: 0.0) + (d.vOutro.toDoubleOrNull() ?: 0.0)
        if (acr > 0) top += lr("Acréscimos R$", Money.plain(Money.fromReais(acr)))
        top += lr("Valor a Pagar R$", money(d.vNF))
        top += lr("FORMA DE PAGAMENTO", "VALOR PAGO R$")
        for (p in d.pagamentos) top += lr(p.label, money(p.valor))
        if ((d.troco.toDoubleOrNull() ?: 0.0) > 0) top += lr("Troco R$", money(d.troco))
        d.tributos?.let { t ->
            wrap("Tributos Totais Incidentes (Lei Federal 12.741/2012): R$ ${money(t.total)} - Federal R$ ${money(t.federal)}, Estadual R$ ${money(t.estadual)}" +
                (if ((t.municipal.toDoubleOrNull() ?: 0.0) > 0) ", Municipal R$ ${money(t.municipal)}" else "") + ". Fonte: ${t.fonte}").forEach { top += Line(it) }
        }
        top += sep
        if (d.tp_amb == 2) top += center("EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL")
        top += center("NFC-e nº ${d.number.toString().padStart(9, '0')} Série ${d.series.toString().padStart(3, '0')} ${whenBr(d.dh_emi)}")
        top += center("Consulte pela Chave de Acesso em")
        top += center(d.url_chave)
        top += center(d.access_key.chunked(4).joinToString(" "))
        top += sep
        top += center(d.cpf?.let { "CONSUMIDOR - CPF ${cpf(it)}" } ?: "CONSUMIDOR NÃO IDENTIFICADO")
        top += sep
        top += center("Consulta via leitor de QR Code")

        val bottom = mutableListOf<Line>()
        if (d.protocol != null) {
            bottom += center("Protocolo de autorização: ${d.protocol}")
            bottom += center("Data de autorização: ${whenBr(d.dh_recbto)}")
        } else bottom += center("NFC-e ainda não autorizada")
        bottom += Line(" ")
        return listOf(TextBlock(top), ImageBlock(qrPng(d.qr_url)), TextBlock(bottom))
    }

    /** Comprovante da venda (não fiscal), enquanto a NFC-e não sai ou quando a loja pede uma via. */
    fun saleReceipt(storeName: String, o: ReceiptOrder, fiscalNote: String?): List<Block> {
        val l = mutableListOf<Line>()
        l += center(storeName, "medium")
        l += center("COMPROVANTE DE VENDA - NÃO É DOCUMENTO FISCAL")
        l += center("Venda ${o.number} - ${whenBr(o.createdAt)}")
        l += sep
        for (i in o.items) {
            wrap(i.name).forEach { l += Line(it) }
            val qty = if (i.qty % 1.0 == 0.0) i.qty.toLong().toString() else i.qty.toString()
            l += lr("  $qty x ${Money.plain(Money.fromReais(i.unitPrice))}", Money.plain(Money.fromReais(i.qty * i.unitPrice)))
            if (i.discount > 0) l += lr("  desconto", "-" + Money.plain(Money.fromReais(i.discount)))
        }
        l += sep
        l += lr("Subtotal", Money.plain(Money.fromReais(o.subtotal)))
        if (o.discount > 0) l += lr("Descontos", "-" + Money.plain(Money.fromReais(o.discount)))
        l += Line(lr("TOTAL R$", Money.plain(Money.fromReais(o.total))).text, "left", "medium")
        for (p in o.payments) {
            l += lr(p.label, Money.plain(Money.fromReais(p.amount)))
            p.authCode?.let { l += Line("  aut. $it") }
        }
        o.cpf?.let { l += Line("CPF: ${cpf(it)}") }
        l += sep
        fiscalNote?.let { wrap(it).forEach { t -> l += Line(t, "center") } }
        l += center("Obrigada pela preferência!")
        l += Line(" ")
        return listOf(TextBlock(l))
    }

    /** Régua para escolher as colunas certas em Ajustes. */
    fun ruler(): List<Block> = listOf(TextBlock(listOf(
        Line("Teste de impressão - $columns colunas", "center", "medium"),
        Line("1234567890".repeat(10).take(columns)),
        lr("Esquerda", "Direita"),
        Line(" "),
    )))

    private fun qrPng(content: String, size: Int = 260): String {
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 1))
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
        val row = IntArray(size)
        for (y in 0 until size) {
            for (x in 0 until size) row[x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
            bmp.setPixels(row, 0, size, 0, y, size, 1)
        }
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
