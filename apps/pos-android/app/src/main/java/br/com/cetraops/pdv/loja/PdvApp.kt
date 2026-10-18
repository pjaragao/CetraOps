package br.com.cetraops.pdv.loja

import android.app.Application
import br.com.cetraops.pdv.loja.data.CatalogStore
import br.com.cetraops.pdv.loja.data.PosApi
import br.com.cetraops.pdv.loja.data.SecureStore
import br.com.cetraops.pdv.loja.print.Printer
import br.com.cetraops.pdv.loja.sale.SaleJournal

/** Dependências do app (sem framework de injeção: são poucas e vivem o processo todo). */
class PdvApp : Application() {
    lateinit var store: SecureStore; private set
    lateinit var api: PosApi; private set
    lateinit var catalog: CatalogStore; private set
    lateinit var journal: SaleJournal; private set
    lateinit var printer: Printer; private set

    override fun onCreate() {
        super.onCreate()
        store = SecureStore(this)
        if (store.serverUrl.isNullOrBlank() && BuildConfig.DEFAULT_SERVER.isNotBlank()) store.serverUrl = BuildConfig.DEFAULT_SERVER
        api = PosApi(store)
        catalog = CatalogStore(this, api.json)
        journal = SaleJournal(this, api.json)
        printer = Printer(this)
    }
}
