package br.com.cetraops.pdv.loja.core

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale

/** Dinheiro sempre em centavos (Long): nada de Double nas contas do caixa. */
object Money {
    private val brl: NumberFormat = NumberFormat.getCurrencyInstance(Locale("pt", "BR"))

    fun fromReais(v: Double): Long = BigDecimal.valueOf(v).setScale(2, RoundingMode.HALF_UP).movePointRight(2).toLong()
    fun toReais(cents: Long): Double = BigDecimal.valueOf(cents).movePointLeft(2).toDouble()
    fun format(cents: Long): String = brl.format(BigDecimal.valueOf(cents).movePointLeft(2))
    /** "1.234,56" (sem R$), para o comprovante. */
    fun plain(cents: Long): String = String.format(Locale("pt", "BR"), "%,.2f", BigDecimal.valueOf(cents).movePointLeft(2))

    /** Lê o que o operador digitou ("12,50", "12.50", "1.234,56", "1250" com centavos implícitos não). */
    fun parse(text: String): Long? {
        val t = text.trim().replace("R$", "").replace(" ", "")
        if (t.isEmpty()) return null
        val normalized = if (t.contains(',')) t.replace(".", "").replace(',', '.') else t
        return normalized.toBigDecimalOrNull()?.takeIf { it.signum() >= 0 }?.setScale(2, RoundingMode.HALF_UP)?.movePointRight(2)?.toLong()
    }

    /** Distribui um desconto entre as linhas proporcionalmente ao valor de cada uma, sem perder centavo (a sobra vai para a maior). */
    fun distribute(totalDiscount: Long, lineTotals: List<Long>): List<Long> {
        val base = lineTotals.sum()
        if (base <= 0 || totalDiscount <= 0) return lineTotals.map { 0L }
        val d = minOf(totalDiscount, base)
        val parts = lineTotals.map { it * d / base }.toMutableList()
        var rest = d - parts.sum()
        val order = lineTotals.indices.sortedByDescending { lineTotals[it] }
        var i = 0
        while (rest > 0) {
            val idx = order[i % order.size]
            if (parts[idx] < lineTotals[idx]) { parts[idx]++; rest-- }
            i++
        }
        return parts
    }
}
