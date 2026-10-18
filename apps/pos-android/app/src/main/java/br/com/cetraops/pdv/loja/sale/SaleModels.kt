package br.com.cetraops.pdv.loja.sale

import br.com.cetraops.pdv.loja.data.Coupon
import br.com.cetraops.pdv.loja.data.Party
import br.com.cetraops.pdv.loja.data.PosProduct
import br.com.cetraops.pdv.loja.data.PosVariant
import kotlinx.serialization.Serializable
import java.math.BigDecimal
import java.math.RoundingMode

enum class PayMethod(val api: String, val label: String) {
    CREDIT("CREDIT", "Crédito"), DEBIT("DEBIT", "Débito"), PIX("PIX", "Pix"), CASH("CASH", "Dinheiro");
    val viaStone get() = this != CASH
}

@Serializable data class CartLine(val id: String, val product: PosProduct, val variant: PosVariant, val qty: Int, val discountCents: Long = 0) {
    val unitCents get() = br.com.cetraops.pdv.loja.core.Money.fromReais(variant.price)
    val grossCents get() = unitCents * qty
    val title get() = listOf(product.name, product.color.ifBlank { null }, variant.size).filterNotNull().joinToString(" · ")
}

@Serializable data class Payment(
    val id: String, val method: PayMethod, val amountCents: Long, val installments: Int = 1,
    val chargeId: String? = null, val atk: String? = null, val authCode: String? = null, val brand: String? = null,
)

/** Cobrança aberta no servidor e enviada ao app da Stone, ainda sem retorno (sobrevive ao app ser fechado). */
@Serializable data class PendingCharge(
    val chargeId: String, val method: PayMethod, val amountCents: Long, val installments: Int, val startedAt: Long,
    /** aprovada na Stone mas o servidor ainda não registrou (sem rede): guarda o retorno para tentar de novo */
    val approvedAtk: String? = null, val approvedUri: String? = null,
)

@Serializable data class SaleDraft(
    val idempotencyKey: String,
    val lines: List<CartLine> = emptyList(),
    val party: Party? = null,
    val cpf: String? = null,
    val coupon: Coupon? = null,
    val discountReason: String? = null,
    val payments: List<Payment> = emptyList(),
    val pending: PendingCharge? = null,
) {
    val subtotalCents get() = lines.sumOf { it.grossCents }
    val itemDiscountCents get() = lines.sumOf { it.discountCents }
    private val netCents get() = subtotalCents - itemDiscountCents

    /** Mesma regra de sales.create_pos_order: cupom sobre o subtotal já com os descontos dos itens; arredonda a 2 casas. */
    val couponCents: Long get() {
        val c = coupon ?: return 0
        if (c.minOrder != null && netCents < BigDecimal.valueOf(c.minOrder).movePointRight(2).toLong()) return 0
        return if (c.kind == "PERCENT") BigDecimal.valueOf(netCents).multiply(BigDecimal.valueOf(c.value)).divide(BigDecimal(100), 0, RoundingMode.HALF_UP).toLong()
        else minOf(BigDecimal.valueOf(c.value).movePointRight(2).toLong(), netCents)
    }
    val couponBelowMinimum get() = coupon?.minOrder?.let { netCents < BigDecimal.valueOf(it).movePointRight(2).toLong() } ?: false
    val totalCents get() = netCents - couponCents
    val paidCents get() = payments.sumOf { it.amountCents }
    val remainingCents get() = maxOf(0, totalCents - paidCents)
    val changeCents get() = maxOf(0, paidCents - totalCents)
    val itemCount get() = lines.sumOf { it.qty }
    /** Com pagamento feito, o carrinho não muda (o valor cobrado tem de bater com a venda). */
    val locked get() = payments.isNotEmpty() || pending != null
}
