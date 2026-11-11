package dev.oraculum.poc.notifications

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore

private val Context.notificationPreferences by preferencesDataStore(name = "oraculum-v2-notifications")

/** Bounded, non-secret notification deduplication; deliberately separate from operation barriers. */
class NotificationLedger(private val store: DataStore<Preferences>) {
    constructor(context: Context) : this(context.applicationContext.notificationPreferences)

    /** Commit before posting. Storage failure suppresses a notification; it never affects writes. */
    suspend fun claim(notice: GatewayNotice): Boolean {
        var claimed = false
        store.edit { preferences ->
            val events = preferences[EVENTS].orEmpty().lineSequence().filter { it.isNotBlank() }.toMutableList()
            val native = preferences[NATIVE].orEmpty().lineSequence().filter { it.isNotBlank() }.toMutableList()
            if (notice.eventKey !in events && notice.nativeKey !in native) {
                events.add(notice.eventKey)
                native.add(notice.nativeKey)
                preferences[EVENTS] = events.takeLast(512).joinToString("\n")
                preferences[NATIVE] = native.takeLast(512).joinToString("\n")
                claimed = true
            }
        }
        return claimed
    }

    private companion object {
        val EVENTS = stringPreferencesKey("event_digests")
        val NATIVE = stringPreferencesKey("native_digests")
    }
}
