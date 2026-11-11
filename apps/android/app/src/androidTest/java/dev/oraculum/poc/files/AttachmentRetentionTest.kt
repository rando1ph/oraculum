package dev.oraculum.poc.files

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class AttachmentRetentionTest {
    @Test fun hundredsOfSettledUploadsRemainBoundedWithoutErasingPendingPayloads() = isolated { context ->
        val store = AttachmentStateStore(context)
        var draft = AttachmentDraft("scope", "project", "thread")
        val protected = listOf("selected", "ready", "unknown", "held", "deleting", "rejected").map { status -> row(draft, status) }
        protected.forEach { store.payload(it.localId).writeText("protected-${it.status}") }
        draft = store.write(draft.copy(rows = protected))
        val terminalIds = mutableListOf<String>()
        repeat(110) { batch ->
            val completed = List(6) { row(draft, if (batch % 2 == 0) "sent" else "expired") }
            completed.forEach { store.payload(it.localId).writeText("terminal"); terminalIds += it.localId }
            draft = store.write(draft.copy(rows = draft.rows + completed))
        }
        val reopened = AttachmentStateStore(context).read(draft.scope, draft.project, draft.thread)
        assertEquals(AttachmentStateStore.TERMINAL_RECORDS + protected.size, reopened.rows.size)
        assertTrue(reopened.cleanupPending.isEmpty())
        protected.forEach { original ->
            assertEquals(original, reopened.rows.single { it.localId == original.localId })
            assertEquals("protected-${original.status}", store.payload(original.localId).readText())
        }
        assertTrue(terminalIds.none { store.payload(it).exists() })
    }

    @Test fun interruptedCleanupResumesFromPersistedTerminalProofOnly() = isolated { context ->
        val store = AttachmentStateStore(context)
        val owner = AttachmentDraft("scope", "project", "thread")
        val pending = row(owner, "unknown"); val terminal = row(owner, "sent")
        store.write(owner.copy(rows = listOf(pending)))
        store.payload(pending.localId).writeText("must survive")
        store.payload(terminal.localId).writeText("already delivered")
        val stateFile = File(context.filesDir, "attachment-drafts-v2").listFiles()!!.single { it.extension == "json" }
        // Crash fixture: the terminal proof/cleanup queue committed, but its payload was not yet deleted.
        stateFile.writeText(Json.encodeToString(owner.copy(rows = listOf(pending, terminal), cleanupPending = listOf(terminal.localId))))
        val restored = AttachmentStateStore(context).read(owner.scope, owner.project, owner.thread)
        assertTrue(restored.cleanupPending.isEmpty()); assertFalse(store.payload(terminal.localId).exists())
        assertEquals("must survive", store.payload(pending.localId).readText())
        // Corrupt cleanup metadata must fail closed instead of deleting an unresolved payload.
        stateFile.writeText(Json.encodeToString(owner.copy(rows = listOf(pending), cleanupPending = listOf(pending.localId))))
        assertThrows(IllegalArgumentException::class.java) { store.read(owner.scope, owner.project, owner.thread) }
        assertEquals("must survive", store.payload(pending.localId).readText())
    }

    private fun row(owner: AttachmentDraft, status: String) = AttachmentLocal(UUID.randomUUID().toString(), owner.draft,
        "note.txt", "text/plain", 4, "0".repeat(64), status, UUID.randomUUID().toString(),
        claimOperation = if (status in setOf("held", "sent")) UUID.randomUUID().toString() else null)

    private fun isolated(test: (Context) -> Unit) {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(base.cacheDir, "attachment-retention-${UUID.randomUUID()}").apply { mkdirs() }
        val context = object : ContextWrapper(base) {
            override fun getApplicationContext(): Context = this
            override fun getFilesDir() = root
        }
        try { test(context) } finally { root.deleteRecursively() }
    }
}
