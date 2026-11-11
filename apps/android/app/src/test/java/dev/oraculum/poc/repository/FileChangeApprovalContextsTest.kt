package dev.oraculum.poc.repository

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class FileChangeApprovalContextsTest {
    private val scope = FileChangeApprovalScope("epoch", "project", "thread")
    private fun obj(value: String) = Json.parseToJsonElement(value).jsonObject
    private fun interaction() = NativeInteractionForms.parse(obj("""{"interactionId":"approval","projectId":"project","threadId":"thread","epoch":"epoch","generation":1,"kind":"fileChange","status":"pending","request":{"threadId":"thread","turnId":"turn","itemId":"item"}}"""))
    private fun change(path: String = "/project/a.txt", type: String = "add", diff: String = "+hello\n", move: String? = null) = buildJsonObject {
        put("path", path); put("diff", diff); put("kind", buildJsonObject { put("type", type); move?.let { put("move_path", it) } })
    }
    private fun item(changes: List<JsonObject> = listOf(change()), status: String = "inProgress") = buildJsonObject {
        put("id", "item"); put("type", "fileChange"); put("status", status); put("changes", JsonArray(changes))
    }
    private fun history(items: List<JsonObject>, status: String = "inProgress", truncated: Boolean = false) = buildJsonObject {
        put("epoch", "epoch"); put("truncated", truncated); put("items", buildJsonArray { add(buildJsonObject {
            put("id", "turn"); put("status", status); put("items", JsonArray(items))
        }) })
    }
    private fun context(item: JsonObject = item()): FileChangeApprovalContext? = FileChangeApprovalContexts().run {
        snapshot(scope, history(listOf(item))); forInteraction(interaction())
    }

    @Test fun completeNativePatchPreservesAllKindsMovesAndExactText() {
        val changes = listOf(change(), change("/project/b.txt", "delete", "-old\n"), change("/project/c.txt", "update", "@@ -1 +1 @@\n-old\n+new\n", "/project/d.txt"))
        val value = context(item(changes))!!
        assertEquals(scope, value.scope); assertEquals("turn", value.turnId); assertEquals("item", value.itemId)
        assertEquals(listOf("add", "delete", "update"), value.changes.map { it.kind })
        assertEquals("/project/d.txt", value.changes.last().movePath)
        assertEquals("@@ -1 +1 @@\n-old\n+new\n", value.changes.last().diff)
        assertTrue(value.digest.matches(Regex("[a-f0-9]{64}")))
    }

    @Test fun patchDigestBindsScopePathKindMoveAndUnmodifiedDiff() {
        val base = context()!!.digest
        listOf(change(diff = "+other\n"), change(path = "/project/b.txt"), change(type = "delete"), change(type = "update", move = "/project/b.txt"))
            .forEach { assertNotEquals(base, context(item(listOf(it)))!!.digest) }
        assertEquals(base, context()!!.digest)
    }

    @Test fun terminalItemOrTurnEmptyChangesAndDuplicateIdentityHaveNoApprovalProof() {
        listOf("completed", "failed", "declined", "future").forEach { assertNull(context(item(status = it))) }
        assertNull(context(item(emptyList())))
        val store = FileChangeApprovalContexts()
        listOf("completed", "interrupted", "failed").forEach { status ->
            store.snapshot(scope, history(listOf(item()), status)); assertNull(store.forInteraction(interaction()))
        }
        store.snapshot(scope, history(listOf(item(), item()))); assertNull(store.forInteraction(interaction()))
    }

    @Test fun fullSnapshotMustBeExplicitlyUntruncatedAndSameEpoch() {
        val store = FileChangeApprovalContexts()
        val full = history(listOf(item()))
        store.snapshot(scope, full); assertNotNull(store.forInteraction(interaction()))
        store.snapshot(scope, JsonObject(full - "truncated")); assertNull(store.forInteraction(interaction()))
        store.snapshot(scope, full); store.snapshot(scope, history(listOf(item()), truncated = true)); assertNull(store.forInteraction(interaction()))
        store.snapshot(scope.copy(epoch = "other"), full); assertNull(store.forInteraction(interaction()))
        store.snapshot(scope, full); store.clear(); assertNull(store.forInteraction(interaction()))
    }

    @Test fun fileByteAndTotalLineBudgetsRejectInsteadOfTruncating() {
        assertNull(context(item(List(21) { change(path = "/project/$it") })))
        assertNotNull(context(item(List(20) { change(path = "/project/$it") })))
        assertNull(context(item(listOf(change(diff = "x".repeat(16 * 1024))))))
        assertNull(context(item(listOf(change(diff = "字".repeat(6000))))))
        assertNull(context(item(listOf(change(diff = "+x" + "\n".repeat(256))))))
        assertNull(context(item(listOf(change(diff = "+x" + "\n".repeat(128)), change(path = "/project/b", diff = "+x" + "\n".repeat(128))))))
        assertNull(context(item(listOf(change(diff = "+x" + "\r".repeat(256))))))
        assertNull(context(item(listOf(change(diff = "+x" + "\u2028".repeat(256))))))
    }

    @Test fun unknownFieldsMissingDiffAndMisleadingPathsCannotBeApproved() {
        val valid = change()
        listOf(JsonObject(valid - "diff"), JsonObject(valid + ("diff" to JsonPrimitive(123))),
            JsonObject(valid + ("futureConstraint" to JsonPrimitive(true))), change(type = "future"),
            change(path = "/project/\u202eevil"), change(path = "/project/a\nb"), change(diff = "+a\u001bb"),
            change(type = "add", move = "/project/other")).forEach { assertNull(context(item(listOf(it)))) }
        assertNull(context(item(listOf(change(), change()))))
        assertNull(context(JsonObject(item() + ("futureConstraint" to JsonPrimitive(true)))))
    }

    @Test fun emptyPatchCannotAuthorizeAnUnspecifiedModification() {
        listOf("", " ", "\n\t").forEach { assertNull(context(item(listOf(change(diff = it))))) }
    }

    @Test fun displayedDigestAlsoBindsTheExactPendingGeneration() {
        val store = FileChangeApprovalContexts()
        store.snapshot(scope, history(listOf(item())))
        val original = interaction()
        val context = store.forInteraction(original)!!
        val replacement = original.copy(generation = original.generation + 1)
        val replacementContext = store.forInteraction(replacement)!!
        assertNotEquals(context.digest, replacementContext.digest)
        assertFalse(replacementContext.matchesPending(replacement, context.digest))
        assertFalse(context.matchesPending(original.copy(id = "replacement"), context.digest))
    }
}
