package dev.oraculum.poc.storage

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flowOf
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class AvatarSelectionTest {
    @get:Rule val temporary = TemporaryFolder()
    private val first = "avatar-11111111-1111-1111-1111-111111111111.png"
    private val second = "avatar-22222222-2222-2222-2222-222222222222.png"
    private val third = "avatar-33333333-3333-3333-3333-333333333333.png"

    @Test fun activityCancellationAfterImportCannotLoseProducedFileOrCommitPointer() = runBlocking {
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = owner) { File(temporary.root, "cancel.preferences_pb") })
            preferences.saveAvatar(first)
            File(temporary.root, first).writeText("old")
            val imported = CountDownLatch(1)
            val allowCommit = CountDownLatch(1)
            var refreshes = 0
            val activity = launch(Dispatchers.Default) {
                commitAvatarSelection(preferences, {
                    File(temporary.root, second).writeText("new")
                    imported.countDown()
                    check(allowCommit.await(5, TimeUnit.SECONDS))
                    second
                }, { name -> if (name != null) File(temporary.root, name).delete() }, { refreshes++ })
            }
            assertTrue(imported.await(5, TimeUnit.SECONDS))
            activity.cancel()
            allowCommit.countDown()
            activity.join()
            assertEquals(second, preferences.snapshot().avatarFileName)
            assertTrue(File(temporary.root, second).isFile)
            assertFalse(File(temporary.root, first).exists())
            assertEquals(1, refreshes)
        } finally { owner.coroutineContext.job.cancelAndJoin() }
    }

    @Test fun rapidSelectionsDeleteOnlyReplacedAssetsAndReadLatestPointer() = runBlocking {
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = owner) { File(temporary.root, "rapid.preferences_pb") })
            preferences.saveAvatar(first)
            val live = mutableSetOf(first)
            val notifications = mutableListOf<() -> Unit>()
            val rendered = mutableListOf<String?>()
            for (next in listOf(second, third)) commitAvatarSelection(preferences, { live += next; next }, { if (it != null) live.remove(it) }, {
                // A delayed UI refresh reads current preferences and never persists a captured earlier filename.
                notifications += { rendered += runBlocking { preferences.snapshot().avatarFileName } }
            })
            notifications.forEach { it() }
            assertEquals(setOf(third), live)
            assertEquals(listOf(third, third), rendered)
            assertEquals(third, preferences.snapshot().avatarFileName)
        } finally { owner.coroutineContext.job.cancelAndJoin() }
    }

    @Test fun failedPointerSavePreservesOldAssetAndDiscardsOnlyNewImport() = runBlocking {
        val store = object : DataStore<Preferences> {
            override val data = flowOf(preferencesOf(stringPreferencesKey("avatar-file-name") to first))
            override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences = throw IOException("storage unavailable")
        }
        val live = mutableSetOf(first)
        assertTrue(runCatching { commitAvatarSelection(ClientPreferences(store), { live += second; second }, { if (it != null) live.remove(it) }, { fail("No notification before commit") }) }.isFailure)
        assertEquals(setOf(first), live)
        assertEquals(first, ClientPreferences(store).snapshot().avatarFileName)
    }
}
