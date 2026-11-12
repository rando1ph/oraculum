package dev.oraculum.poc.storage

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class IdentityPreferencesTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun appearanceAndAvatarSurviveReopenAndEndpointChanges() = runBlocking {
        val file = File(temporary.root, "identity.preferences_pb")
        var owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val avatar = "avatar-12345678-1234-1234-1234-123456789abc.png"
        try {
            var preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = owner) { file })
            preferences.saveTheme("oled")
            preferences.saveAccent("violet")
            preferences.saveIdentityLabels("本机用户", "神谕")
            preferences.saveAvatar(avatar)
            preferences.saveEndpoint("https://first.invalid/")
            preferences.saveSelection("scope", "project", "thread")
            owner.coroutineContext.job.cancelAndJoin()
            owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = owner) { file })
            preferences.saveEndpoint("https://second.invalid/")
            val restored = preferences.snapshot()
            assertEquals("oled", restored.themeMode)
            assertEquals("violet", restored.accentColor)
            assertEquals(avatar, restored.avatarFileName)
            assertEquals("本机用户", restored.userLabel)
            assertEquals("神谕", restored.assistantLabel)
            assertNull(restored.threadId)
            preferences.saveAvatar(null)
            assertNull(preferences.snapshot().avatarFileName)
            assertEquals("violet", preferences.snapshot().accentColor)
        } finally { owner.coroutineContext.job.cancelAndJoin() }
    }

    @Test fun corruptAppearanceFieldsRecoverWithoutTouchingOtherPreferences() = runBlocking {
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val store = PreferenceDataStoreFactory.create(scope = owner) { File(temporary.root, "corrupt.preferences_pb") }
            val preferences = ClientPreferences(store)
            preferences.saveIdentityLabels("保留称呼", "助手")
            store.edit {
                it[stringPreferencesKey("accent-color")] = "untrusted"
                it[stringPreferencesKey("avatar-file-name")] = "../../credentials.json"
            }
            val restored = preferences.snapshot()
            assertEquals("matcha", restored.accentColor)
            assertNull(restored.avatarFileName)
            assertEquals("保留称呼", restored.userLabel)
            assertTrue(runCatching { preferences.saveAvatar("content://external/avatar") }.isFailure)
            assertTrue(runCatching { preferences.saveAccent("unknown") }.isFailure)
            assertEquals("保留称呼", preferences.snapshot().userLabel)
        } finally { owner.coroutineContext.job.cancelAndJoin() }
    }
}
