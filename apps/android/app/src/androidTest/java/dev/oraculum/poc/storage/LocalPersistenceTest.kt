package dev.oraculum.poc.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.util.Log
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Real SQLite/Room and Preferences DataStore on the Android target, with disposable test files. */
@RunWith(AndroidJUnit4::class)
class LocalPersistenceTest {
    private lateinit var context: Context
    private lateinit var cacheDb: CacheDatabase
    private lateinit var stateDb: StateDatabase
    private lateinit var prefix: String
    private lateinit var cacheName: String
    private lateinit var stateName: String
    private val scope = CacheScope("https://gateway.invalid/poc/", "test-installation", "test-device")
    private val projectId = "test-project"
    private val threadId = "native-thread"

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        prefix = "oraculum-p2-storage-${UUID.randomUUID()}"
        cacheName = "$prefix-cache.db"
        stateName = "$prefix-state.db"
        cacheDb = CacheDatabase.open(context, cacheName)
        stateDb = StateDatabase.open(context, stateName)
    }

    @After
    fun tearDown() {
        cacheDb.close()
        stateDb.close()
        context.deleteDatabase(cacheName)
        context.deleteDatabase(stateName)
    }

    @Test
    fun clearAndRebuildCachePreservesDraftUnknownAndReadingPositionAfterReopen() = runBlocking {
        val operation = OperationRecord(scope.key, UUID.randomUUID().toString(), projectId, threadId, "turn/start")
        val draft = DraftRecord(scope.key, projectId, threadId, "offline unsent draft")
        val anchor = ReadAnchorRecord(scope.key, projectId, threadId, "native-item", 37, false)
        stateDb.state().putDraft(draft)
        stateDb.state().putReadAnchor(anchor)
        stateDb.state().insertOperation(operation)
        cacheDb.cache().putWithCursor(history(), StoredEventCursor(scope.key, "epoch-one", 42))
        assertEquals(42L, cacheDb.cache().cursor(scope.key)?.sequence)

        cacheDb.cache().clearAll()
        assertTrue(cacheDb.cache().listByKind(scope.key, "history").isEmpty())
        assertNull(cacheDb.cache().cursor(scope.key))
        assertEquals(draft, stateDb.state().draft(scope.key, projectId, threadId))
        assertEquals(operation, stateDb.state().unresolved(scope.key).single())

        // A disposable history file can also be rebuilt without touching the durable state file.
        cacheDb.close()
        assertTrue(context.deleteDatabase(cacheName))
        cacheDb = CacheDatabase.open(context, cacheName)
        stateDb.close()
        stateDb = StateDatabase.open(context, stateName)
        assertNull(cacheDb.cache().get(scope.key, "history", threadId, projectId = projectId))
        assertEquals(draft, stateDb.state().observeDraft(scope.key, projectId, threadId).first())
        assertEquals(anchor, stateDb.state().readAnchor(scope.key, projectId, threadId))
        assertEquals(operation, stateDb.state().observeUnresolved(scope.key).first().single())
    }

    @Test
    fun duplicateIdsAbortAndTerminalReceiptCannotRegress() = runBlocking {
        val operation = OperationRecord(scope.key, UUID.randomUUID().toString(), projectId, threadId, "turn/start")
        stateDb.state().insertOperation(operation)
        assertTrue(runCatching { stateDb.state().insertOperation(operation) }.isFailure)
        assertEquals(operation, stateDb.state().operation(scope.key, operation.operationId))

        assertEquals(1, stateDb.state().updateOperationReceipt(
            scope.key, operation.operationId, "accepted", "sent", threadId, "native-turn", "{\"status\":\"accepted\"}",
        ))
        assertEquals(0, stateDb.state().updateOperationReceipt(scope.key, operation.operationId, "unknown", "unknown"))
        assertEquals(0, stateDb.state().updateOperationReceipt(scope.key, operation.operationId, "rejected", "notSent"))
        stateDb.close()
        stateDb = StateDatabase.open(context, stateName)
        val accepted = stateDb.state().operation(scope.key, operation.operationId)!!
        assertEquals("accepted", accepted.status)
        assertEquals("native-turn", accepted.nativeTurnId)
        assertTrue(stateDb.state().unresolved(scope.key).isEmpty())
        assertTrue(runCatching { stateDb.state().insertOperation(operation) }.isFailure)
    }

    @Test
    fun identityAndBasePathPartitionCachedAndDurableData() = runBlocking {
        cacheDb.cache().put(history())
        stateDb.state().putDraft(DraftRecord(scope.key, projectId, threadId, "private draft"))
        stateDb.state().insertOperation(OperationRecord(scope.key, UUID.randomUUID().toString(), projectId, null, "thread/start"))
        listOf(
            scope.copy(endpoint = "https://gateway.invalid/other/"),
            scope.copy(installationId = "another-installation"),
            scope.copy(deviceId = "another-device"),
        ).forEach { other ->
            assertNotEquals(scope.key, other.key)
            assertNull(cacheDb.cache().get(other.key, "history", threadId, projectId = projectId))
            assertNull(stateDb.state().draft(other.key, projectId, threadId))
            assertTrue(stateDb.state().unresolved(other.key).isEmpty())
        }
        assertFalse(stateDb.state().unresolved(scope.key).isEmpty())
    }

    @Test
    fun sameNativeThreadUnderDifferentProjectsHasSeparateCacheAndDrafts() = runBlocking {
        val otherProject = "another-project"
        val first = history()
        val second = history().copy(projectId = otherProject, payloadJson = "{\"items\":[]}")
        cacheDb.cache().put(first)
        cacheDb.cache().put(second)
        stateDb.state().putDraft(DraftRecord(scope.key, projectId, threadId, "first project draft"))
        stateDb.state().putDraft(DraftRecord(scope.key, otherProject, threadId, "second project draft"))
        assertEquals(first, cacheDb.cache().get(scope.key, "history", threadId, projectId = projectId))
        assertEquals(second, cacheDb.cache().get(scope.key, "history", threadId, projectId = otherProject))
        assertEquals(listOf(second), cacheDb.cache().listByKind(scope.key, "history", otherProject))
        cacheDb.cache().deleteThread(scope.key, projectId, threadId)
        assertNull(cacheDb.cache().get(scope.key, "history", threadId, projectId = projectId))
        assertEquals(second, cacheDb.cache().get(scope.key, "history", threadId, projectId = otherProject))
        assertEquals("first project draft", stateDb.state().draft(scope.key, projectId, threadId)?.text)
        assertEquals("second project draft", stateDb.state().draft(scope.key, otherProject, threadId)?.text)
    }

    @Test
    fun corruptedCacheFileCanBeRebuiltWithoutErasingDraftOrUnknownOperation() = runBlocking {
        cacheDb.close()
        stateDb.close()
        val draft = DraftRecord(scope.key, projectId, threadId, "draft survives corrupted history")
        val operation = OperationRecord(scope.key, UUID.randomUUID().toString(), projectId, threadId, "turn/start")
        LocalStore(context, cacheName, stateName).use { store ->
            store.state.putDraft(draft)
            store.state.insertOperation(operation)
            store.cache.put(history())
        }
        RandomAccessFile(context.getDatabasePath(cacheName), "rw").use { file ->
            file.seek(0)
            file.write(ByteArray(16) { 0x55.toByte() })
            file.fd.sync()
        }
        LocalStore(context, cacheName, stateName).use { reopened ->
            val firstRead = runCatching { reopened.cache.get(scope.key, "history", threadId, projectId = projectId) }
            if (firstRead.isFailure) {
                assertTrue(generateSequence(firstRead.exceptionOrNull()) { it.cause }
                    .any { it is SQLiteDatabaseCorruptException })
                Log.i("OraculumStorageTest", "Confirmed corrupt cache requires explicit reconstruction")
            } else {
                assertNull(firstRead.getOrThrow())
                Log.i("OraculumStorageTest", "SQLite reconstructed corrupt cache during open")
            }
            // Also exercise the explicit recovery path on this actual corrupted-cache scenario.
            reopened.rebuildCache()
            assertNull(reopened.cache.get(scope.key, "history", threadId, projectId = projectId))
            assertEquals(draft, reopened.state.draft(scope.key, projectId, threadId))
            assertEquals(operation, reopened.state.unresolved(scope.key).single())
            reopened.cache.put(history())
            assertEquals("opaque-revision", reopened.cache.get(scope.key, "history", threadId, projectId = projectId)?.revision)
        }
    }

    @Test
    fun corruptedDurableStateFailsClosedWithoutDeletingUnknownRecords() = runBlocking {
        val operation = OperationRecord(scope.key, UUID.randomUUID().toString(), projectId, threadId, "turn/start")
        stateDb.state().insertOperation(operation)
        stateDb.close()
        val file = context.getDatabasePath(stateName)
        val originalHeader = ByteArray(16)
        RandomAccessFile(file, "rw").use {
            it.readFully(originalHeader)
            it.seek(0)
            it.write(ByteArray(16) { 0x55.toByte() })
            it.fd.sync()
        }
        stateDb = StateDatabase.open(context, stateName)
        val read = runCatching { stateDb.state().unresolved(scope.key) }
        assertTrue("Corrupt durable state must refuse reads rather than silently reset", read.isFailure)
        assertTrue(generateSequence(read.exceptionOrNull()) { it.cause }
            .any { it is SQLiteDatabaseCorruptException })
        assertTrue(file.exists())
        stateDb.close()
        // Restore only this test's deliberately damaged header to prove its operation was not lost.
        RandomAccessFile(file, "rw").use {
            it.write(originalHeader)
            it.fd.sync()
        }
        stateDb = StateDatabase.open(context, stateName)
        assertEquals(operation, stateDb.state().unresolved(scope.key).single())
    }

    @Test
    fun preferencesSurviveReopeningAndEndpointChangeClearsOnlyNavigation() = runBlocking {
        val file = File(context.filesDir, "$prefix.preferences_pb")
        var dataStoreScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            var preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = dataStoreScope) { file })
            preferences.saveEndpoint(scope.endpoint)
            preferences.saveSelection(scope.key, projectId, threadId)
            stateDb.state().putDraft(DraftRecord(scope.key, projectId, threadId, "retained draft"))
            dataStoreScope.coroutineContext.job.cancelAndJoin()

            dataStoreScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            preferences = ClientPreferences(PreferenceDataStoreFactory.create(scope = dataStoreScope) { file })
            assertEquals(ClientPreferenceSnapshot(scope.endpoint, scope.key, projectId, threadId), preferences.snapshot())
            preferences.saveEndpoint(scope.endpoint)
            assertEquals(threadId, preferences.snapshot().threadId)
            preferences.saveEndpoint("https://other.invalid/")
            assertEquals(ClientPreferenceSnapshot("https://other.invalid/"), preferences.snapshot())
            assertEquals("retained draft", stateDb.state().draft(scope.key, projectId, threadId)?.text)
        } finally {
            dataStoreScope.coroutineContext.job.cancelAndJoin()
            file.delete()
        }
    }

    private fun history() = CachedProjection(
        scopeKey = scope.key,
        kind = "history",
        resourceId = threadId,
        payloadJson = "{\"items\":[{\"id\":\"native-item\",\"turnId\":\"native-turn\",\"text\":\"cached\"}]}",
        epoch = "epoch-one",
        revision = "opaque-revision",
        projectId = projectId,
        threadId = threadId,
        source = "native-read-projection",
        complete = true,
    )
}
