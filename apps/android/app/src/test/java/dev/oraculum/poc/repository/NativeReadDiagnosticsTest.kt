package dev.oraculum.poc.repository

import dev.oraculum.poc.gateway.GatewayException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class NativeReadDiagnosticsTest {
    @Test fun diagnosticsPreserveAuthenticationFailureAndNeverRetryTheRead() = runBlocking {
        val failure = GatewayException("DEVICE_REVOKED", "Device revoked", 403)
        var calls = 0
        try {
            observeNativeRead(NativeReadStage.MODELS, "连接校正") { calls++; throw failure }
            fail("The original read failed")
        } catch (error: NativeReadFailed) {
            assertSame(failure, error.cause)
            assertTrue((error.cause as GatewayException).authInvalid)
            assertEquals(NativeReadStage.MODELS, error.stage)
            assertEquals("连接校正", error.context)
            assertTrue(error.elapsedMillis >= 0)
        }
        assertEquals(1, calls)
    }

    @Test fun cancellationRemainsCancellationAndDoesNotBecomeARecoverableReadFailure() = runBlocking {
        val cancellation = CancellationException("Activity disposed")
        var calls = 0
        try {
            observeNativeRead(NativeReadStage.SNAPSHOT, "连接校正") { calls++; throw cancellation }
            fail("Cancellation should propagate")
        } catch (error: CancellationException) { assertSame(cancellation, error) }
        assertEquals(1, calls)
    }
}
