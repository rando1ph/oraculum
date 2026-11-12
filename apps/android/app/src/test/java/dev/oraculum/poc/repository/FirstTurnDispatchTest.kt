package dev.oraculum.poc.repository

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Composition of the same durable-intent/prepare/auth/enqueue cut points used by the ViewModel. */
class FirstTurnDispatchTest {
    private fun fresh() = FirstTurnPermit().also {
        it.acceptedStart("project", "thread", "epoch", 7)
        assertTrue(it.confirmNativeIdle("project", "thread", "epoch", 7, "idle"))
    }
    private class Attempt {
        var receipt = "unknown"
        var enqueued = 0
        suspend fun run(permit: FirstTurnPermit, prepare: () -> Unit = {}, auth: () -> Unit = {},
            generation: Int = 7, loseAck: Boolean = false) {
            prepareWriteRequest(prepare = { prepare() }, rejectNotSent = { receipt = "rejected/notSent" })
            dispatchWriteRequest({ markDispatched ->
                auth()
                // The actual caller also checks epoch, generation, selected scope and other unknowns.
                check(permit.allows("project", "thread", "epoch", generation, true, false))
                check(permit.consume("project", "thread", "epoch", generation))
                markDispatched()
                enqueued++
                if (loseAck) throw IOException("lost acknowledgement")
                receipt = "accepted"
            }, { receipt = "rejected/notSent" })
        }
    }

    @Test fun localPrepareFailureRetainsPermitForExplicitLaterAttempt() = runBlocking {
        val permit = fresh()
        val failed = Attempt()
        try { failed.run(permit, prepare = { throw IllegalStateException("attachment expired locally") }) }
        catch (_: IllegalStateException) { }
        assertEquals("rejected/notSent", failed.receipt)
        assertEquals(0, failed.enqueued)
        assertTrue(permit.allows("project", "thread", "epoch", 7, true, false))
        val explicitLaterAttempt = Attempt()
        explicitLaterAttempt.run(permit)
        assertEquals("accepted", explicitLaterAttempt.receipt)
        assertEquals(1, explicitLaterAttempt.enqueued)
        assertFalse(permit.allows("project", "thread", "epoch", 7, true, false))
    }

    @Test fun authFailureBeforeBusinessEnqueueKeepsProofUntilConnectionInvalidatesIt() = runBlocking {
        val permit = fresh()
        val failed = Attempt()
        try { failed.run(permit, auth = { throw IOException("authentication exchange failed") }) }
        catch (_: IOException) { }
        assertEquals("rejected/notSent", failed.receipt)
        assertEquals(0, failed.enqueued)
        assertTrue(permit.allows("project", "thread", "epoch", 7, true, false))
        permit.invalidate() // Real connection/auth failure still discards the in-memory proof.
        assertFalse(permit.allows("project", "thread", "epoch", 8, true, false))
    }

    @Test fun cancellationBeforeEnqueueSettlesNotSentWithoutConsumingProof() = runBlocking {
        val permit = fresh()
        val cancelled = Attempt()
        try { cancelled.run(permit, auth = { throw CancellationException("cancel before business enqueue") }) }
        catch (_: CancellationException) { }
        assertEquals("rejected/notSent", cancelled.receipt)
        assertEquals(0, cancelled.enqueued)
        assertTrue(permit.allows("project", "thread", "epoch", 7, true, false))
    }

    @Test fun changedGenerationCannotDispatchOrRecreateTheOldProof() = runBlocking {
        val permit = fresh()
        val changed = Attempt()
        try { changed.run(permit, auth = { permit.invalidate() }, generation = 8) }
        catch (_: IllegalStateException) { }
        assertEquals("rejected/notSent", changed.receipt)
        assertEquals(0, changed.enqueued)
        assertFalse(permit.confirmNativeIdle("project", "thread", "epoch", 8, "idle"))
    }

    @Test fun lostAcknowledgementAfterEnqueueConsumesProofAndNeverRetries() = runBlocking {
        val permit = fresh()
        val unknown = Attempt()
        try { unknown.run(permit, loseAck = true) } catch (_: IOException) { }
        assertEquals("unknown", unknown.receipt)
        assertEquals(1, unknown.enqueued)
        assertFalse(permit.allows("project", "thread", "epoch", 7, true, false))
        assertFalse(permit.confirmNativeIdle("project", "thread", "epoch", 7, "idle"))
    }

    @Test fun acceptedStartIsKeptBeforeListFailureButStillNeedsFreshIdleInSameGeneration() {
        val permit = FirstTurnPermit()
        permit.acceptedStart("project", "thread", "epoch", 7)
        try { throw IOException("optional list read failed") } catch (_: IOException) { }
        assertFalse(permit.allows("project", "thread", "epoch", 7, true, false))
        assertTrue(permit.confirmNativeIdle("project", "thread", "epoch", 7, "idle"))
        assertTrue(permit.allows("project", "thread", "epoch", 7, true, false))
        assertFalse(permit.allows("project", "thread", "epoch", 8, true, false))
        permit.invalidate()
        assertFalse(permit.confirmNativeIdle("project", "thread", "epoch", 8, "idle"))
    }
}
