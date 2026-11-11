package dev.oraculum.poc.storage

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.floatPreferencesKey
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
    val themeMode: String = "dark",
    val userLabel: String = "你",
    val assistantLabel: String = "Oraculum",
    val readingScale: Float = 1f,
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
            themeMode = preferences[THEME]?.takeIf { it in setOf("light", "dark", "oled") } ?: "dark",
            userLabel = preferences[USER_LABEL] ?: "你",
            assistantLabel = preferences[ASSISTANT_LABEL] ?: "Oraculum",
            readingScale = preferences[READING_SCALE]?.takeIf { it.isFinite() }?.coerceIn(0.85f, 1.4f) ?: 1f,
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

    suspend fun saveTheme(mode: String) {
        require(mode in setOf("light", "dark", "oled"))
        store.edit { it[THEME] = mode }
    }

    suspend fun saveIdentityLabels(user: String, assistant: String) {
        require(user.length in 1..40 && assistant.length in 1..40)
        store.edit { it[USER_LABEL] = user; it[ASSISTANT_LABEL] = assistant }
    }
    suspend fun saveReadingScale(scale: Float) {
        require(scale.isFinite() && scale in 0.85f..1.4f)
        store.edit { it[READING_SCALE] = scale }
    }

    private companion object {
        val USER_LABEL = stringPreferencesKey("user-label")
        val ASSISTANT_LABEL = stringPreferencesKey("assistant-label")
        val READING_SCALE = floatPreferencesKey("reading-scale")
        val THEME = stringPreferencesKey("theme")
        val ENDPOINT = stringPreferencesKey("endpoint")
        val SCOPE = stringPreferencesKey("scope")
        val PROJECT = stringPreferencesKey("project")
        val THREAD = stringPreferencesKey("thread")
    }
}
