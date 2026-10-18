package br.com.cetraops.pdv.loja

import br.com.cetraops.pdv.loja.core.Money
import br.com.cetraops.pdv.loja.data.Coupon
import br.com.cetraops.pdv.loja.data.PosProduct
import br.com.cetraops.pdv.loja.data.PosVariant
import br.com.cetraops.pdv.loja.sale.CartLine
import br.com.cetraops.pdv.loja.sale.PayMethod
import br.com.cetraops.pdv.loja.sale.Payment
import br.com.cetraops.pdv.loja.sale.SaleDraft
import br.com.cetraops.pdv.loja.sale.SaleViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SaleMathTest {
    private fun line(price: Double, qty: Int, disc: Long = 0) = CartLine(
        "l$price$qty", PosProduct("k", "Legging", "REF1", variants = emptyList()), PosVariant("v$price", "SKU", "M", null, price, 10.0), qty, disc,
    )

    @Test fun parsesWhatTheOperatorTypes() {
        assertEquals(1250L, Money.parse("12,50"))
        assertEquals(1250L, Money.parse("12.50"))
        assertEquals(123456L, Money.parse("1.234,56"))
        assertEquals(1000L, Money.parse("R$ 10"))
        assertEquals(null, Money.parse("abc"))
        assertEquals(null, Money.parse("-5"))
    }

    @Test fun reaisRoundTripWithoutFloatingErrors() {
        assertEquals(1999L, Money.fromReais(19.99))
        assertEquals(10L, Money.fromReais(0.1))
        assertEquals(19.99, Money.toReais(1999), 0.0)
    }

    @Test fun distributesDiscountWithoutLosingCents() {
        val parts = Money.distribute(1000, listOf(3333, 3333, 3334))
        assertEquals(1000L, parts.sum())
        assertTrue(parts.all { it in 333..334 })
        assertEquals(listOf(0L, 0L), Money.distribute(0, listOf(100, 200)))
        assertEquals(300L, Money.distribute(999, listOf(100, 200)).sum())    // nunca maior que os itens
    }

    @Test fun couponFollowsCreatePosOrderRule() {
        // 10% sobre o subtotal já com o desconto dos itens: (2×89,90 + 120 − 10) × 10% = 28,98
        val d = SaleDraft("k", lines = listOf(line(89.90, 2), line(120.0, 1, disc = 1000)), coupon = Coupon("TRAINER", "PERCENT", 10.0))
        assertEquals(29980L, d.subtotalCents)
        assertEquals(2898L, d.couponCents)
        assertEquals(29980L - 1000 - 2898, d.totalCents)
    }

    @Test fun fixedCouponNeverAboveNetAndRespectsMinimum() {
        val fixed = SaleDraft("k", lines = listOf(line(30.0, 1)), coupon = Coupon("VALE50", "FIXED", 50.0))
        assertEquals(3000L, fixed.couponCents)
        assertEquals(0L, fixed.totalCents)
        val min = SaleDraft("k", lines = listOf(line(30.0, 1)), coupon = Coupon("MIN100", "PERCENT", 10.0, minOrder = 100.0))
        assertTrue(min.couponBelowMinimum)
        assertEquals(0L, min.couponCents)
    }

    @Test fun cashChangeAndLock() {
        val d = SaleDraft("k", lines = listOf(line(89.90, 1)), payments = listOf(Payment("p", PayMethod.CASH, 10000)))
        assertEquals(0L, d.remainingCents)
        assertEquals(1010L, d.changeCents)
        assertTrue(d.locked)
        assertFalse(SaleDraft("k", lines = listOf(line(1.0, 1))).locked)
    }

    @Test fun validatesCpf() {
        assertTrue(SaleViewModel.validCpf("52998224725"))
        assertFalse(SaleViewModel.validCpf("52998224724"))
        assertFalse(SaleViewModel.validCpf("11111111111"))
    }
}
