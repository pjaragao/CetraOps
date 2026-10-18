package br.com.cetraops.pdv.loja.stone

import android.net.Uri
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** Retornos dos apps da Stone que chegam na MainActivity, entregues para quem está esperando (cobrança, estorno, impressão). */
object DeeplinkBus {
    private val _events = MutableSharedFlow<Uri>(replay = 1, extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events: SharedFlow<Uri> = _events.asSharedFlow()

    fun publish(uri: Uri) { _events.tryEmit(uri) }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun consume() = _events.resetReplayCache()
}
