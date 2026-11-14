package dev.oraculum.poc.storage

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import dev.oraculum.poc.ui.NavigationSort
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class NavigationSortPreferencesTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun missingKeysUseIndependentProjectAndThreadDefaults() = runBlocking {
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = owner) {
                File(temporary.root, "defaults.preferences_pb")
            })

            assertEquals(NavigationSort.NameAscending, ClientPreferenceSnapshot().projectSort)
            assertEquals(NavigationSort.CreatedNewest, ClientPreferenceSnapshot().threadSort)
            assertEquals(NavigationSort.NameAscending, preferences.snapshot().projectSort)
            assertEquals(NavigationSort.CreatedNewest, preferences.snapshot().threadSort)
        } finally {
            owner.coroutineContext.job.cancelAndJoin()
        }
    }

    @Test fun namesAreSerializedExactlyAndBothChoicesSurviveReopenAndEndpointChange() = runBlocking {
        val file = File(temporary.root, "sort.preferences_pb")
        var owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val store = PreferenceDataStoreFactory.create(scope = owner) { file }
            var preferences = ClientPreferences(store)
            preferences.saveEndpoint("https://first.invalid/")
            preferences.saveSelection("original-scope", "original-project", "original-thread")
            preferences.saveIdentityLabels("保留用户", "保留助手")
            preferences.saveTheme("oled")
            NavigationSort.values().forEach { sort ->
                preferences.saveProjectSort(sort)
                preferences.saveThreadSort(sort)
                val raw = store.data.first()
                assertEquals(sort.name, raw[stringPreferencesKey("project-sort")])
                assertEquals(sort.name, raw[stringPreferencesKey("thread-sort")])
                val snapshot = preferences.snapshot()
                assertEquals(sort, snapshot.projectSort)
                assertEquals(sort, snapshot.threadSort)
                assertEquals("original-scope", snapshot.scopeKey)
                assertEquals("original-thread", snapshot.threadId)
            }
            preferences.saveProjectSort(NavigationSort.NameDescending)
            preferences.saveThreadSort(NavigationSort.UpdatedNewest)
            owner.coroutineContext.job.cancelAndJoin()
            owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = owner) { file })
            assertEquals(NavigationSort.NameDescending, preferences.snapshot().projectSort)
            assertEquals(NavigationSort.UpdatedNewest, preferences.snapshot().threadSort)

            preferences.saveEndpoint("https://second.invalid/")
            val restored = preferences.snapshot()
            assertEquals(NavigationSort.NameDescending, restored.projectSort)
            assertEquals(NavigationSort.UpdatedNewest, restored.threadSort)
            assertEquals("保留用户", restored.userLabel)
            assertEquals("保留助手", restored.assistantLabel)
            assertEquals("oled", restored.themeMode)
            assertNull(restored.scopeKey)
            assertNull(restored.projectId)
            assertNull(restored.threadId)
        } finally {
            owner.coroutineContext.job.cancelAndJoin()
        }
    }

    @Test fun invalidStoredNamesFallBackWithoutChangingTheOtherChoiceOrIdentity() = runBlocking {
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val store = PreferenceDataStoreFactory.create(scope = owner) {
                File(temporary.root, "invalid-sort.preferences_pb")
            }
            val preferences = ClientPreferences(store)
            preferences.saveIdentityLabels("保留用户", "保留助手")
            preferences.saveSelection("scope", "project", "thread")
            preferences.saveThreadSort(NavigationSort.UpdatedNewest)
            store.edit { it[stringPreferencesKey("project-sort")] = "FutureSort" }

            assertEquals(NavigationSort.NameAscending, preferences.snapshot().projectSort)
            assertEquals(NavigationSort.UpdatedNewest, preferences.snapshot().threadSort)
            preferences.saveProjectSort(NavigationSort.NameDescending)
            store.edit { it[stringPreferencesKey("thread-sort")] = "creatednewest" }
            assertEquals(NavigationSort.NameDescending, preferences.snapshot().projectSort)
            assertEquals(NavigationSort.CreatedNewest, preferences.snapshot().threadSort)

            listOf("", "FutureSort", " NameAscending ").forEach { invalid ->
                store.edit {
                    it[stringPreferencesKey("project-sort")] = invalid
                    it[stringPreferencesKey("thread-sort")] = invalid
                }
                val restored = preferences.snapshot()
                assertEquals(NavigationSort.NameAscending, restored.projectSort)
                assertEquals(NavigationSort.CreatedNewest, restored.threadSort)
                assertEquals("scope", restored.scopeKey)
                assertEquals("project", restored.projectId)
                assertEquals("thread", restored.threadId)
                assertEquals("保留用户", restored.userLabel)
                assertEquals("保留助手", restored.assistantLabel)
            }
        } finally {
            owner.coroutineContext.job.cancelAndJoin()
        }
    }

    @Test fun savingOneSortDoesNotReplaceTheOtherSort() = runBlocking {
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = owner) {
                File(temporary.root, "independent-sort.preferences_pb")
            })
            preferences.saveProjectSort(NavigationSort.UpdatedNewest)
            assertEquals(NavigationSort.CreatedNewest, preferences.snapshot().threadSort)
            preferences.saveThreadSort(NavigationSort.NameDescending)
            assertEquals(NavigationSort.UpdatedNewest, preferences.snapshot().projectSort)
            assertEquals(NavigationSort.NameDescending, preferences.snapshot().threadSort)
        } finally {
            owner.coroutineContext.job.cancelAndJoin()
        }
    }
}
