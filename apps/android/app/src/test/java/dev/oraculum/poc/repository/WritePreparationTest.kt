package dev.oraculum.poc.repository

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class WritePreparationTest {
    @Test fun attachmentClaimFailureBeforeHttpIsKnownNotSent() = runBlocking {
        var receipt = "unknown"
        var dispatched = false
        try {
            prepareWriteRequest<String>({ throw IllegalStateException("attachment expired") }, { receipt = "rejected/notSent" })
            dispatched = true
        } catch (_: IllegalStateException) { }
        assertEquals("rejected/notSent", receipt)
        assertFalse(dispatched)
    }
    @Test fun cancellationDuringLocalPrepareStillCompletesDurableRejection() = runBlocking {
        var rejected = false
        try { prepareWriteRequest<Unit>({ throw CancellationException("cancel") }, { rejected = true }) }
        catch (_: CancellationException) { }
        assertTrue(rejected)
    }
    @Test fun networkFailureAfterPreparationDoesNotClaimNotSent() = runBlocking {
        var rejected = false
        try {
            assertEquals("request", prepareWriteRequest({ "request" }, { rejected = true }))
            throw java.io.IOException("connection lost after dispatch")
        } catch (_: java.io.IOException) { }
        assertFalse(rejected)
    }
}
