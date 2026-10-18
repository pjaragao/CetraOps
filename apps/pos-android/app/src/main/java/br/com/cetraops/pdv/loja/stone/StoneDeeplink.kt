package br.com.cetraops.pdv.loja.stone

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import br.com.cetraops.pdv.loja.BuildConfig

/**
 * Integração com os apps da Stone no próprio POS Android por Deeplink (modelo recomendado pela Stone no SDK Android:
 * https://sdkandroid.stone.com.br/reference/explicacao-deeplink). O app de pagamento cuida de cartão, senha, Pix e comprovante do cliente;
 * o resultado volta para a MainActivity em <RETURN_SCHEME>://pay-response | cancel | print.
 */
object StoneDeeplink {
    val returnScheme: String = BuildConfig.RETURN_SCHEME

    enum class Method(val api: String, val stone: String) { CREDIT("CREDIT", "CREDIT"), DEBIT("DEBIT", "DEBIT"), PIX("PIX", "PIX") }

    fun paymentUri(amountCents: Long, method: Method, installments: Int): Uri = Uri.Builder()
        .scheme("payment-app").authority("pay")
        .appendQueryParameter("return_scheme", returnScheme)
        .appendQueryParameter("amount", amountCents.toString())
        .appendQueryParameter("editable_amount", "0")
        .appendQueryParameter("transaction_type", method.stone)
        .apply {
            // à vista: NONE; parcelado sem juros (lojista): MERCHANT com 2..12
            if (method == Method.CREDIT && installments >= 2) {
                appendQueryParameter("installment_type", "MERCHANT")
                appendQueryParameter("installment_count", installments.toString())
            } else {
                appendQueryParameter("installment_type", "NONE")
            }
        }
        .build()

    /** Estorno: com o ATK a Stone vai direto na transação; sem ele, o operador escolhe no app de cancelamento. */
    fun cancelUri(atk: String?, amountCents: Long?): Uri = Uri.Builder()
        .scheme("cancel-app").authority("cancel")
        .appendQueryParameter("returnscheme", returnScheme)        // a documentação usa os dois nomes
        .appendQueryParameter("return_scheme", returnScheme)
        .apply {
            if (!atk.isNullOrBlank()) appendQueryParameter("atk", atk)
            if (amountCents != null) appendQueryParameter("amount", amountCents.toString())
            appendQueryParameter("editable_amount", if (atk.isNullOrBlank()) "true" else "false")
        }
        .build()

    fun printUri(printableJson: String, showFeedback: Boolean = false): Uri = Uri.Builder()
        .scheme("printer-app").authority("print")
        .appendQueryParameter("SHOW_FEEDBACK_SCREEN", showFeedback.toString())
        .appendQueryParameter("SCHEME_RETURN", returnScheme)
        .appendQueryParameter("PRINTABLE_CONTENT", printableJson)
        .build()

    fun intent(uri: Uri): Intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** O terminal tem o app da Stone para esse deeplink? (em celular comum não tem: o app usa o simulador no build de teste) */
    fun isAvailable(context: Context, uri: Uri): Boolean =
        context.packageManager.queryIntentActivities(Intent(Intent.ACTION_VIEW, uri), PackageManager.MATCH_DEFAULT_ONLY).isNotEmpty()

    // ---------- Retornos ----------
    sealed interface PaymentResult {
        data class Approved(
            val amountCents: Long, val atk: String, val itk: String?, val authorizationCode: String?, val brand: String?,
            val installmentCount: Int?, val type: String?, val pan: String?, val entryMode: String?, val authorizationDateTime: String?,
        ) : PaymentResult
        data class Declined(val code: String?, val message: String) : PaymentResult
    }

    fun parsePayment(uri: Uri): PaymentResult {
        val code = uri.getQueryParameter("code")
        val success = uri.getQueryParameter("success")
        val atk = uri.getQueryParameter("atk")
        if (code == "0" && success != "false" && !atk.isNullOrBlank()) {
            return PaymentResult.Approved(
                amountCents = uri.getQueryParameter("amount")?.toLongOrNull() ?: -1,
                atk = atk,
                itk = uri.getQueryParameter("itk"),
                authorizationCode = uri.getQueryParameter("authorization_code"),
                brand = uri.getQueryParameter("brand"),
                installmentCount = uri.getQueryParameter("installment_count")?.toIntOrNull(),
                type = uri.getQueryParameter("type"),
                pan = uri.getQueryParameter("pan"),
                entryMode = uri.getQueryParameter("entry_mode"),
                authorizationDateTime = uri.getQueryParameter("authorization_date_time"),
            )
        }
        val reason = uri.getQueryParameter("reason")
        val message = uri.getQueryParameter("message")
            ?: when (code) { "2" -> "Pagamento encerrado no app da Stone"; else -> "Pagamento não aprovado" }
        return PaymentResult.Declined(reason ?: code, if (reason != null) "$message ($reason)" else message)
    }

    data class CancelResult(val success: Boolean, val atk: String?, val reason: String?, val responseCode: String?)

    fun parseCancel(uri: Uri) = CancelResult(
        success = uri.getQueryParameter("success") == "true",
        atk = uri.getQueryParameter("atk"),
        reason = uri.getQueryParameter("reason"),
        responseCode = uri.getQueryParameter("responsecode"),
    )

    enum class PrintStatus(val message: String) {
        SUCCESS("Impresso"),
        PRINTER_OUT_OF_PAPER("Sem papel ou tampa da bobina aberta"),
        PRINTER_INIT_ERROR("Erro ao iniciar a impressora"),
        PRINTER_LOW_ENERGY("Bateria baixa para imprimir"),
        PRINTER_BUSY("Impressora ocupada"),
        PRINTER_UNSUPPORTED_FORMAT("Formato de impressão não aceito"),
        PRINTER_INVALID_DATA("Conteúdo grande demais para a impressora"),
        UNKNOWN("Retorno da impressora desconhecido"),
    }

    fun parsePrint(uri: Uri): PrintStatus {
        val s = Uri.decode(uri.toString()).uppercase()
        return PrintStatus.entries.firstOrNull { it != PrintStatus.UNKNOWN && s.contains(it.name) } ?: if (s.contains("ERROR")) PrintStatus.UNKNOWN else PrintStatus.SUCCESS
    }
}
