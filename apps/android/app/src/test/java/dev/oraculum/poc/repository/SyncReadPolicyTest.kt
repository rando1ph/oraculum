package dev.oraculum.poc.repository

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.*
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SyncReadPolicyTest {
    @Test fun automaticReadsReuseFreshNavigationButExplicitInvalidationAndExpiryReadAgain() {
        var now = 0L
        val policy = SyncReadPolicy({ now })
        var requests = 0
        fun automaticRead() {
            if (!policy.fresh("threads:p")) {
                val ticket = policy.version("threads:p"); requests++; policy.checked("threads:p", ticket)
            }
        }
        repeat(10) { now += 1_000; automaticRead() }
        assertEquals(1, requests)
        policy.invalidate("threads:p"); automaticRead()
        assertEquals(2, requests)
        now += 30_000; automaticRead()
        assertEquals(3, requests)
    }

    @Test fun eventDuringFirstReadAndOldScopeCompletionCannotMarkDataFresh() {
        val policy = SyncReadPolicy({ 0 })
        val first = policy.version("threads:p")
        policy.invalidatePrefix("threads:")
        policy.checked("threads:p", first)
        assertFalse(policy.fresh("threads:p"))
        val second = policy.version("threads:p")
        policy.clear()
        policy.checked("threads:p", second)
        assertFalse(policy.fresh("threads:p"))
        val current = policy.version("threads:p")
        policy.checked("threads:p", current)
        assertTrue(policy.fresh("threads:p"))
    }

    @Test fun unrelatedThreadInvalidationsAndInflightRegistrationsHaveABoundedBudget() {
        val policy = SyncReadPolicy({ 0 })
        val evicted = policy.version("snapshot:old")
        repeat(2_000) { policy.invalidate("snapshot:$it"); policy.version("threads:$it") }
        assertTrue(policy.size() <= 256)
        policy.checked("snapshot:old", evicted)
        assertFalse(policy.fresh("snapshot:old"))
        assertTrue(policy.size() <= 256)
    }

    @Test fun configurationAndAccountHaveIndependentBoundedRefreshAges() {
        var now = 0L
        val policy = SyncReadPolicy({ now })
        for (key in listOf("threads:p", "native-defaults:p", "account")) policy.checked(key, policy.version(key))
        now = 30_000
        assertFalse(policy.fresh("threads:p"))
        assertTrue(policy.fresh("native-defaults:p", 60_000))
        assertTrue(policy.fresh("account", 300_000))
        now = 60_000
        assertFalse(policy.fresh("native-defaults:p", 60_000))
        assertTrue(policy.fresh("account", 300_000))
        now = 300_000
        assertFalse(policy.fresh("account", 300_000))
    }

    @Test fun pausedStreamUsesBoundedReadsAndTerminalCompletionConvergesPromptly() = runTest {
        var baseline = 0
        var optimized = 0
        var baselineJob: Job? = null
        val scheduler = SnapshotRefreshScheduler(this, { testScheduler.currentTime }) { optimized++ }
        repeat(12) {
            baselineJob?.cancel(); baselineJob = launch { delay(300); baseline++ }
            scheduler.request(5_000)
            advanceTimeBy(1_000); runCurrent()
        }
        assertEquals(12, baseline)
        assertEquals(2, optimized)
        baselineJob?.cancel(); baselineJob = launch { delay(300); baseline++ }
        scheduler.request(300)
        advanceTimeBy(300); runCurrent()
        assertEquals(13, baseline)
        assertEquals(3, optimized)
        println("STREAM_READS baseline=$baseline optimized=$optimized elapsedMs=${testScheduler.currentTime}")
        scheduler.cancel()
    }

    @Test fun aSlowReadIsSharedAcrossBurstsAndNeverCancelledByNewEvents() = runTest {
        var calls = 0
        val release = CompletableDeferred<Unit>()
        val scheduler = SnapshotRefreshScheduler(this, { testScheduler.currentTime }) {
            calls++
            if (calls == 1) release.await()
        }
        scheduler.request(0); runCurrent()
        repeat(20) { scheduler.request(300) }
        advanceTimeBy(1_000); runCurrent()
        assertEquals(1, calls)
        assertFalse(release.isCancelled)
        release.complete(Unit); runCurrent()
        advanceTimeBy(300); runCurrent()
        assertEquals(2, calls)
        scheduler.cancel()
    }

    @Test fun cancelledScopeFinallyCannotOverwriteTheNextScopesScheduler() = runTest {
        var calls = 0
        val oldCleanup = CompletableDeferred<Unit>()
        val currentRead = CompletableDeferred<Unit>()
        val scheduler = SnapshotRefreshScheduler(this, { testScheduler.currentTime }) {
            when (++calls) {
                1 -> try { CompletableDeferred<Unit>().await() }
                    finally { withContext(NonCancellable) { oldCleanup.await() } }
                2 -> currentRead.await()
            }
        }
        scheduler.request(0); runCurrent()
        scheduler.cancel(); runCurrent()
        scheduler.request(0); runCurrent()
        scheduler.request(300)
        oldCleanup.complete(Unit); runCurrent()
        currentRead.complete(Unit); runCurrent()
        advanceTimeBy(300); runCurrent()
        assertEquals(3, calls)
        scheduler.cancel()
    }

    @Test fun reconnectReplaysFromTheProvenCursorRatherThanDiscardingEventsBelowHead() {
        val checkpoint = EventResumeCheckpoint()
        checkpoint.remember("scope", EventPosition("installation", "epoch", 7))
        val cursor = checkpoint.cursor("scope", "installation", "epoch")!!
        val position = eventConnectionPosition("installation", "epoch", 10, false, cursor)
        assertEquals(7L, position.sequence)
        assertEquals(EventDecision.APPLY, acceptEvent(position, "installation", "epoch", 8, "item.delta", "state"))
        assertEquals(10L, eventConnectionPosition("installation", "epoch", 10, true, cursor).sequence)
        assertNull(checkpoint.cursor("other-scope", "installation", "epoch"))
        assertNull(checkpoint.cursor("scope", "other-installation", "epoch"))
        assertNull(checkpoint.cursor("scope", "installation", "new-epoch"))
        checkpoint.clear()
        assertNull(checkpoint.cursor("scope", "installation", "epoch"))
        assertNull(EventResumeCheckpoint().cursor("scope", "installation", "epoch"))
    }

    @Test fun rootRevisionEpochAndDestructiveChangesInvalidateTheLoadedPageWindow() {
        fun root(text: String) = Json.parseToJsonElement("""{"items":[{"id":"t","status":"completed","items":[{"id":"recent","type":"agentMessage","text":"$text"}]}],"truncated":false,"source":"native-read-projection"}""").jsonObject
        val original = root("new")
        assertTrue(preserveHistoryWindow("epoch", "epoch", "r", "r", original, original, false))
        assertFalse(preserveHistoryWindow("epoch", "new-epoch", "r", "r", original, original, false))
        assertFalse(preserveHistoryWindow("epoch", "epoch", "r", "new-revision", original, original, false))
        assertFalse(preserveHistoryWindow("epoch", "epoch", "r", "r", original, root("changed"), false))
        assertFalse(preserveHistoryWindow("epoch", "epoch", "r", "r", original, original, true))
        val projection = HistoryProjection()
        projection.snapshot(original)
        val older = Json.parseToJsonElement("""{"items":[{"id":"old-turn","status":"completed","items":[{"id":"older","type":"agentMessage","text":"old"}]}],"truncated":false}""").jsonObject
        projection.applyHistory(older, older = true)
        projection.applyVerifiedDetail(Json.parseToJsonElement("""{"id":"older","type":"agentMessage","text":"verified older detail"}""").jsonObject, "old-turn")
        projection.snapshot(original, preserveOlder = true)
        assertEquals(listOf("older", "recent"), projection.messages().map { it.id })
        assertEquals("verified older detail", projection.messages().first().text)
        projection.snapshot(original, preserveTerminal = false)
        assertEquals(listOf("recent"), projection.messages().map { it.id })
    }
}
