package dev.oraculum.poc.files

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.gateway.GatewayClient
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Exact pre-dispatch cutpoint: cancelling after durable reservation must never become a lost write. */
class FilesCancellationTest {
    @Test fun canceledDeleteSettlesOriginalScopeAndBlocksOverlapUntilCleanupCompletes() = runBlocking {
        val application = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(application.cacheDir, "files-cancel-${UUID.randomUUID()}").apply { mkdirs() }
        val context = object : ContextWrapper(application) {
            override fun getApplicationContext(): Context = this
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
            override fun getCacheDir() = File(root, "cache").apply { mkdirs() }
        }
        val owner = AttachmentDraft("scope-a", "project-a", "thread-a")
        val row = AttachmentLocal(UUID.randomUUID().toString(), owner.draft, "note.txt", "text/plain", 4,
            "0".repeat(64), "ready", UUID.randomUUID().toString(), UUID.randomUUID().toString(), System.currentTimeMillis() + 60_000)
        val store = AttachmentStateStore(context)
        withContext(Dispatchers.IO) { store.payload(row.localId).writeText("note"); store.write(owner.copy(rows = listOf(row))) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val reserved = CompletableDeferred<String>(); val cleaning = CompletableDeferred<Unit>(); val finishCleanup = CompletableDeferred<Unit>()
        val completed = CompletableDeferred<String>(); val calls = AtomicInteger()
        val controller = FilesController(context, GatewayClient(context), scope,
            beginWrite = { id, _, _, _ -> calls.incrementAndGet(); reserved.complete(id); awaitCancellation() },
            acceptReceipt = { error("No business request was sent") }, beforeDispatch = { error("No business request was sent") },
            notDispatched = { id -> cleaning.complete(Unit); finishCleanup.await(); completed.complete(id) })
        val capabilities = buildJsonObject { put("capabilities", buildJsonArray {
            listOf("files", "attachments").forEach { name -> add(buildJsonObject { put("name", name); put("supported", true) }) }
        }) }
        try {
            withContext(Dispatchers.Main) { controller.bind(owner.scope, owner.project, owner.thread, true, capabilities); controller.remove(row.localId) }
            val operation = withTimeout(10_000) { reserved.await() }
            withContext(Dispatchers.Main) { controller.cancel() }
            withTimeout(10_000) { cleaning.await() }
            // isActive is already false, but known-notSent cleanup still owns the dispatch context.
            withContext(Dispatchers.Main) { controller.remove(row.localId) }
            assertEquals(1, calls.get())
            withContext(Dispatchers.Main) { controller.bind("scope-b", "project-b", "thread-b", true, capabilities) }
            finishCleanup.complete(Unit)
            assertEquals(operation, withTimeout(10_000) { completed.await() })
            val restored = withContext(Dispatchers.IO) { store.read(owner.scope, owner.project, owner.thread) }
            assertEquals("ready", restored.rows.single().status)
            assertNull(restored.rows.single().deleteOperation)
            assertEquals("note", store.payload(row.localId).readText())
            assertTrue(controller.state.value.attachments.isEmpty())
        } finally { finishCleanup.complete(Unit); scope.cancel(); withContext(Dispatchers.IO) { root.deleteRecursively() } }
    }
}
