package br.com.cetraops.pdv.loja.data

import kotlinx.serialization.Serializable

// ---------- Pareamento e sessão ----------
@Serializable data class PairRequest(val code: String, val serial: String?, val model: String?, val appVersion: String?)
@Serializable data class PairedDevice(val id: String, val name: String, val storeId: String, val storeName: String)
@Serializable data class PairResponse(val deviceToken: String, val device: PairedDevice)
@Serializable data class LoginRequest(val email: String, val password: String)
@Serializable data class RefreshRequest(val refreshToken: String)
@Serializable data class SessionTokens(val accessToken: String, val refreshToken: String, val expiresAt: Long)

@Serializable data class Operator(val name: String, val canDiscount: Boolean, val canCustomItem: Boolean)
@Serializable data class Named(val id: String, val name: String)
@Serializable data class Bootstrap(
    val operator: Operator, val device: Named, val store: Named, val cashSessionId: String? = null,
    val stoneEnvironment: String = "producao", val serverTime: String? = null,
)

// ---------- Catálogo ----------
@Serializable data class PosVariant(val id: String, val sku: String, val size: String, val gtin: String? = null, val price: Double, val available: Double)
@Serializable data class PosProduct(
    val key: String, val name: String, val reference: String, val gender: String = "", val color: String = "",
    val backorder: Boolean = false, val variants: List<PosVariant>,
)
@Serializable data class CatalogResponse(val products: List<PosProduct>, val generatedAt: String? = null)

// ---------- Cliente e cupom ----------
@Serializable data class CustomerRequest(val phone: String, val name: String? = null, val marketing: Boolean = false)
@Serializable data class Party(val id: String, val name: String, val tier: String? = null)
@Serializable data class Coupon(val code: String, val kind: String, val value: Double, val minOrder: Double? = null, val validTo: String? = null)
@Serializable data class CustomerResponse(val party: Party, val autoCoupon: Coupon? = null, val storeCredit: Double = 0.0)

// ---------- Cobrança na maquininha (Deeplink) ----------
@Serializable data class OpenChargeRequest(val amount: Double, val method: String, val installments: Int)
@Serializable data class OpenChargeResponse(val chargeId: String, val amount: Double, val method: String, val installments: Int)
@Serializable data class ConfirmChargeRequest(
    val amountCents: Long, val atk: String, val itk: String? = null, val authorizationCode: String? = null, val brand: String? = null,
    val installmentCount: Int? = null, val type: String? = null, val pan: String? = null, val entryMode: String? = null, val authorizationDateTime: String? = null,
)
@Serializable data class ConfirmChargeResponse(
    val ok: Boolean, val nsu: String? = null, val authCode: String? = null, val brand: String? = null, val installments: Int? = null, val amount: Double = 0.0,
)
@Serializable data class CloseChargeRequest(val status: String, val code: String? = null, val message: String? = null)

// ---------- Venda ----------
@Serializable data class SaleItemDto(
    val variantId: String, val qty: Int, val discountAmount: Double = 0.0, val discountReason: String? = null,
)
@Serializable data class SalePaymentDto(
    val method: String, val amount: Double, val installments: Int, val anticipation: String = "D1",
    val nsu: String? = null, val authCode: String? = null, val brand: String? = null, val stoneOrderId: String? = null,
)
@Serializable data class SaleRequest(
    val idempotencyKey: String, val partyId: String?, val cpfOnInvoice: String?, val couponCode: String?,
    val items: List<SaleItemDto>, val payments: List<SalePaymentDto>,
)
@Serializable data class SaleResponse(val orderId: String, val number: String, val total: Double)

@Serializable data class SaleSummary(val id: String, val number: String, val total: Double, val status: String, val createdAt: String, val customer: String? = null)
@Serializable data class SalesList(val sales: List<SaleSummary>)

// ---------- Comprovante e NFC-e ----------
@Serializable data class ReceiptItem(val name: String, val sku: String? = null, val qty: Double, val unitPrice: Double, val discount: Double, val total: Double)
@Serializable data class ReceiptPayment(val label: String, val amount: Double, val authCode: String? = null, val nsu: String? = null)
@Serializable data class ReceiptOrder(
    val id: String, val number: String, val createdAt: String, val status: String, val cpf: String? = null,
    val subtotal: Double, val discount: Double, val total: Double, val paid: Double,
    val items: List<ReceiptItem>, val payments: List<ReceiptPayment>,
)
@Serializable data class NfcePrint(val status: String? = null, val protocol: String? = null, val danfe: Danfe? = null)
@Serializable data class FiscalInfo(val status: String, val message: String? = null, val consultUrl: String? = null, val nfce: NfcePrint? = null)
@Serializable data class ReceiptResponse(val order: ReceiptOrder, val fiscal: FiscalInfo? = null)

/** Dados do DANFE NFC-e gravados pelo emissor (mesmo formato da página /imprimir/nfce/[id]). */
@Serializable data class Danfe(
    val emit: DanfeEmit, val items: List<DanfeItem>,
    val vProd: String, val vDesc: String, val vFrete: String = "0", val vOutro: String = "0", val vNF: String, val troco: String = "0",
    val pagamentos: List<DanfePag>, val access_key: String, val number: Long, val series: Int, val dh_emi: String, val tp_amb: Int,
    val qr_url: String, val url_chave: String, val cpf: String? = null, val protocol: String? = null, val dh_recbto: String? = null,
    val tributos: DanfeTributos? = null,
)
@Serializable data class DanfeEmit(val razao_social: String, val fantasia: String? = null, val cnpj: String, val ie: String? = null, val endereco: String)
@Serializable data class DanfeItem(val codigo: String, val descricao: String, val qtd: String, val un: String, val vun: String, val vtot: String)
@Serializable data class DanfePag(val label: String, val valor: String, val tPag: String? = null)
@Serializable data class DanfeTributos(val federal: String, val estadual: String, val municipal: String, val total: String, val fonte: String)

@Serializable data class ApiError(val error: String? = null)
