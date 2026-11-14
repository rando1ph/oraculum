package dev.oraculum.poc.storage

import android.content.Context
import dev.oraculum.poc.ui.NavigationSort
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
    val accentColor: String = "matcha",
    val avatarFileName: String? = null,
    val projectSort: NavigationSort = NavigationSort.NameAscending,
    val threadSort: NavigationSort = NavigationSort.CreatedNewest,
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
            accentColor = preferences[ACCENT]?.takeIf { it in ACCENT_COLOR_KEYS } ?: "matcha",
            avatarFileName = preferences[AVATAR]?.takeIf(::isAvatarFileName),
            projectSort = NavigationSort.entries.firstOrNull { it.name == preferences[PROJECT_SORT] } ?: NavigationSort.NameAscending,
            threadSort = NavigationSort.entries.firstOrNull { it.name == preferences[THREAD_SORT] } ?: NavigationSort.CreatedNewest,
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

    suspend fun saveProjectSort(sort: NavigationSort) {
        store.edit { it[PROJECT_SORT] = sort.name }
    }

    suspend fun saveThreadSort(sort: NavigationSort) {
        store.edit { it[THREAD_SORT] = sort.name }
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

    suspend fun saveAccent(color: String) {
        require(color in ACCENT_COLOR_KEYS)
        store.edit { it[ACCENT] = color }
    }

    suspend fun saveAvatar(fileName: String?) {
        require(fileName == null || isAvatarFileName(fileName))
        store.edit { if (fileName == null) it.remove(AVATAR) else it[AVATAR] = fileName }
    }

    private companion object {
        val PROJECT_SORT = stringPreferencesKey("project-sort")
        val THREAD_SORT = stringPreferencesKey("thread-sort")
        val USER_LABEL = stringPreferencesKey("user-label")
        val ACCENT = stringPreferencesKey("accent-color")
        val AVATAR = stringPreferencesKey("avatar-file-name")
        val ASSISTANT_LABEL = stringPreferencesKey("assistant-label")
        val READING_SCALE = floatPreferencesKey("reading-scale")
        val THEME = stringPreferencesKey("theme")
        val ENDPOINT = stringPreferencesKey("endpoint")
        val SCOPE = stringPreferencesKey("scope")
        val PROJECT = stringPreferencesKey("project")
        val THREAD = stringPreferencesKey("thread")
    }
}

val ACCENT_COLOR_KEYS = setOf("matcha", "ocean", "violet", "rose", "amber", "teal")

/** Preferences hold a private asset name, never an external URI or arbitrary path. */
internal fun isAvatarFileName(value: String): Boolean = Regex("avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png").matches(value)
