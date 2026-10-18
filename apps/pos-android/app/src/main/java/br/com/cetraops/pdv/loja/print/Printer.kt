package br.com.cetraops.pdv.loja.print

import android.content.Context
import android.util.Log
import br.com.cetraops.pdv.loja.stone.DeeplinkBus
import br.com.cetraops.pdv.loja.stone.StoneDeeplink
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** Impressão pela bobina do terminal (Deeplink de impressão da Stone): um bloco por vez, esperando o retorno de cada um. */
class Printer(private val context: Context) {
    private val lock = Mutex()

    suspend fun print(blocks: List<Receipts.Block>): StoneDeeplink.PrintStatus = lock.withLock {
        for (b in blocks) {
            val uri = StoneDeeplink.printUri(b.json)
            if (!StoneDeeplink.isAvailable(context, uri)) {
                Log.i("Printer", "Sem app de impressão da Stone (aparelho de teste). Conteúdo: ${b.json.take(400)}")
                return@withLock StoneDeeplink.PrintStatus.PRINTER_INIT_ERROR
            }
            DeeplinkBus.consume()
            context.startActivity(StoneDeeplink.intent(uri))
            val back = withTimeoutOrNull(60_000) { DeeplinkBus.events.first { it.host == "print" } }
                ?: return@withLock StoneDeeplink.PrintStatus.UNKNOWN
            DeeplinkBus.consume()
            val status = StoneDeeplink.parsePrint(back)
            if (status != StoneDeeplink.PrintStatus.SUCCESS) return@withLock status
        }
        StoneDeeplink.PrintStatus.SUCCESS
    }
}
