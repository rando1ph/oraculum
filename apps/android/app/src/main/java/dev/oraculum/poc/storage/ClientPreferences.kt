package dev.oraculum.poc.storage

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.oraculumV2Preferences by preferencesDataStore(name = "oraculum-v2-preferences")

data class ClientPreferenceSnapshot(
    val endpoint: String = "",
    val scopeKey: String? = null,
    val projectId: String? = null,
    val threadId: String? = null,
)

/** Small, non-secret preferences only; a new namespace never reads the legacy WebView state. */
class ClientPreferences(private val store: DataStore<Preferences>) {
    constructor(context: Context) : this(context.applicationContext.oraculumV2Preferences)

    val flow: Flow<ClientPreferenceSnapshot> = store.data.map { preferences ->
        ClientPreferenceSnapshot(
            endpoint = preferences[ENDPOINT].orEmpty(),
            scopeKey = preferences[SCOPE],
            projectId = preferences[PROJECT],
            threadId = preferences[THREAD],
        )
    }

    suspend fun snapshot(): ClientPreferenceSnapshot = flow.first()

    suspend fun saveEndpoint(endpoint: String) {
        store.edit { preferences ->
            if (preferences[ENDPOINT] != endpoint) {
                preferences.remove(SCOPE)
                preferences.remove(PROJECT)
                preferences.remove(THREAD)
            }
            preferences[ENDPOINT] = endpoint
        }
    }

    suspend fun saveSelection(scopeKey: String, projectId: String?, threadId: String?) {
        require(threadId == null || projectId != null)
        store.edit { preferences ->
            preferences[SCOPE] = scopeKey
            if (projectId == null) preferences.remove(PROJECT) else preferences[PROJECT] = projectId
            if (threadId == null) preferences.remove(THREAD) else preferences[THREAD] = threadId
        }
    }

    private companion object {
        val ENDPOINT = stringPreferencesKey("endpoint")
        val SCOPE = stringPreferencesKey("scope")
        val PROJECT = stringPreferencesKey("project")
        val THREAD = stringPreferencesKey("thread")
    }
}
