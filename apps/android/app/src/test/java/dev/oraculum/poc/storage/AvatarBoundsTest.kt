package dev.oraculum.poc.storage

import java.io.IOException
import java.io.InputStream
import org.junit.Assert.*
import org.junit.Test

class AvatarBoundsTest {
    @Test fun boundsRejectExcessivePixelsAndInvalidDimensionsBeforeDecode() {
        assertTrue(AvatarStore.validDimensions(8000, 4000))
        assertTrue(AvatarStore.validDimensions(8192, 1))
        listOf(0 to 1, 1 to -1, 8193 to 1, 8000 to 4001, Int.MAX_VALUE to Int.MAX_VALUE).forEach { (width, height) ->
            assertFalse("$width × $height", AvatarStore.validDimensions(width, height))
        }
    }

    @Test fun readsAtMostOneByteBeyondLimitWithoutTrustingProviderSize() {
        var consumed = 0
        val endless = object : InputStream() {
            override fun read(): Int { consumed++; return 1 }
        }
        assertThrows(IllegalArgumentException::class.java) { AvatarStore.boundedBytes(endless, 100) }
        assertEquals(101, consumed)
        val exact = ByteArray(100) { it.toByte() }
        assertArrayEquals(exact, AvatarStore.boundedBytes(exact.inputStream(), 100))
    }

    @Test fun zeroLengthReadsCannotSpinAndInterruptedProvidersFail() {
        val brieflyEmpty = object : InputStream() {
            private var read = false
            override fun read(bytes: ByteArray, offset: Int, length: Int) = if (read) -1 else 0
            override fun read(): Int { read = true; return 7 }
        }
        assertArrayEquals(byteArrayOf(7), AvatarStore.boundedBytes(brieflyEmpty, 10))
        assertThrows(IOException::class.java) { AvatarStore.boundedBytes(object : InputStream() {
            override fun read(): Int = throw IOException("revoked provider")
        }, 10) }
    }
}
