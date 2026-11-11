package dev.oraculum.poc.repository

import org.junit.Assert.*
import org.junit.Test

class FirstTurnPermitTest {
    private fun fresh(): FirstTurnPermit = FirstTurnPermit().also {
        it.acceptedStart("project", "thread", "epoch", 7)
        assertTrue(it.confirmNativeIdle("project", "thread", "epoch", 7, "idle"))
    }

    @Test fun `accepted start alone does not permit send until native idle is confirmed`() {
        val permit = FirstTurnPermit()
        assertFalse(permit.confirmNativeIdle("project", "thread", "epoch", 7, "idle"))
        permit.acceptedStart("project", "thread", "epoch", 7)
        assertFalse(permit.allows("project", "thread", "epoch", 7, true, false))
        assertFalse(permit.confirmNativeIdle("project", "thread", "epoch", 7, "active"))
        assertFalse(permit.confirmNativeIdle("project", "thread", "epoch", 7, "idle"))
    }

    @Test fun `durable first turn intent consumes proof even if result remains unknown`() {
        val permit = fresh()
        assertTrue(permit.consume("project", "thread", "epoch", 7))
        assertFalse(permit.consume("project", "thread", "epoch", 7))
        assertFalse(permit.confirmNativeIdle("project", "thread", "epoch", 7, "idle"))
        assertFalse(permit.allows("project", "thread", "epoch", 7, true, false))
    }

    @Test fun `proof cannot cross connection epoch selection or unknown barrier`() {
        val permit = fresh()
        assertFalse(permit.allows("project", "thread", "epoch", 7, true, true))
        assertFalse(permit.allows("project", "thread", "epoch", 7, false, false))
        assertFalse(permit.allows("project", "thread", "epoch", 8, true, false))
        assertFalse(permit.allows("project", "thread", "new-epoch", 7, true, false))
        assertFalse(permit.allows("another", "thread", "epoch", 7, true, false))
        assertFalse(permit.allows("project", "another", "epoch", 7, true, false))
        permit.invalidate() // Disconnect/reset never reinstates the old generation's proof.
        assertFalse(permit.confirmNativeIdle("project", "thread", "epoch", 7, "idle"))
    }

    @Test fun `observed native activity invalidates matching thread proof`() {
        val permit = fresh()
        permit.invalidate("different-thread")
        assertTrue(permit.allows("project", "thread", "epoch", 7, true, false))
        permit.invalidate("thread")
        assertFalse(permit.allows("project", "thread", "epoch", 7, true, false))
    }
}
