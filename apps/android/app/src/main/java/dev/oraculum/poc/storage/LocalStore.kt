package dev.oraculum.poc.storage

import android.content.Context
import java.io.Closeable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Separate files make a reconstructed history cache incapable of erasing drafts or unknown writes. */
class LocalStore internal constructor(context: Context, private val cacheName: String, stateName: String) : Closeable {
    constructor(context: Context) : this(context, CacheDatabase.FILE_NAME, StateDatabase.FILE_NAME)

    private val applicationContext = context.applicationContext
    private val lifecycleLock = Any()
    private var closed = false
    private var cacheDatabase = CacheDatabase.open(applicationContext, cacheName)
    private val stateDatabase = StateDatabase.open(applicationContext, stateName)
    val cache: CacheDao
        get() = synchronized(lifecycleLock) {
            check(!closed) { "Local storage is closed" }
            cacheDatabase.cache()
        }
    val state: StateDao = stateDatabase.state()
    val preferences = ClientPreferences(context)

    init {
        require(cacheName != stateName) { "Cache and durable state must use separate files" }
    }

    /**
     * Recovery for confirmed history corruption only. The caller serializes its cache operations
     * while rebuilding and obtains a fresh [cache] DAO afterwards. Drafts, receipts and preferences
     * are untouched. Ordinary failures (full disk, permissions, state corruption) must fail closed.
     */
    suspend fun rebuildCache() = withContext(Dispatchers.IO) {
        synchronized(lifecycleLock) {
            check(!closed) { "Local storage is closed" }
            cacheDatabase.close()
            val deleted = applicationContext.deleteDatabase(cacheName)
            check(deleted || !applicationContext.getDatabasePath(cacheName).exists()) { "History cache could not be rebuilt" }
            cacheDatabase = CacheDatabase.open(applicationContext, cacheName)
        }
    }

    override fun close() {
        synchronized(lifecycleLock) {
            if (!closed) {
                closed = true
                cacheDatabase.close()
                stateDatabase.close()
            }
        }
    }
}
