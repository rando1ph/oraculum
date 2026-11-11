package dev.oraculum.poc.files

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64

class FileTransferPolicyTest {
    private val contents = "verified file\n".toByteArray()
    private val grant = HostFileGrant("00000000-0000-4000-8000-000000000001", "project", "thread", "output/result.txt", "result.txt", "text/plain", contents.size.toLong(), 20_000)
    private val digest = MessageDigest.getInstance("SHA-256").digest(contents)
    private fun headers(selected: HostFileGrant = grant, mime: String = "text/plain", size: String = contents.size.toString(),
        hash: String = "sha-256=:${Base64.getEncoder().encodeToString(digest)}:", disposition: String = "attachment; filename*=UTF-8''result.txt", now: Long = 10_000) =
        FileTransferPolicy.validateHeaders(selected, mime, size, hash, disposition, now)

    @Test fun verifiesExactAuthorizedHeadersAndBytes() {
        val expected = headers(); val target = ByteArrayOutputStream(); var progress = 0L
        FileTransferPolicy.copyVerified(contents.inputStream(), target, grant.size, expected, progress = { count, _ -> progress = count })
        assertArrayEquals(contents, target.toByteArray()); assertEquals(grant.size, progress)
    }
    @Test fun rejectsExpiredReplacedMimeSizeNameAndDigest() {
        assertThrows(IllegalArgumentException::class.java) { headers(now = 20_000) }
        assertThrows(IllegalArgumentException::class.java) { headers(mime = "text/html") }
        assertThrows(IllegalArgumentException::class.java) { headers(size = "1") }
        assertThrows(IllegalArgumentException::class.java) { headers(disposition = "attachment; filename*=UTF-8''other.txt") }
        assertThrows(IllegalStateException::class.java) { headers(hash = "") }
        assertThrows(IllegalArgumentException::class.java) { FileTransferPolicy.copyVerified("replaced file".byteInputStream(), ByteArrayOutputStream(), grant.size, digest) }
    }
    @Test fun rejectsShortOverlongInterruptedAndRevokedStreams() {
        assertThrows(IllegalArgumentException::class.java) { FileTransferPolicy.copyVerified(contents.copyOf(2).inputStream(), ByteArrayOutputStream(), grant.size, digest) }
        assertThrows(IllegalArgumentException::class.java) { FileTransferPolicy.copyVerified((contents + 1).inputStream(), ByteArrayOutputStream(), grant.size, digest) }
        val interrupted = object : InputStream() { override fun read(): Int = throw IOException("interrupted") }
        assertThrows(IOException::class.java) { FileTransferPolicy.copyVerified(interrupted, ByteArrayOutputStream(), grant.size, digest) }
        assertThrows(SecurityException::class.java) { FileTransferPolicy.copyVerified(contents.inputStream(), ByteArrayOutputStream(), grant.size, digest, { throw SecurityException("revoked") }) }
    }
    @Test fun refusesUnsafeHostPathsAndActiveContentTypes() {
        listOf("/etc/passwd", "../file.txt", "foo/../file.txt", "foo/%2e.txt", "foo\\bar.txt", "a//b.txt", "secret\u0000.txt").forEach { assertFalse(it, FileTransferPolicy.relativePath(it)) }
        listOf("result.html", "picture.svg", "program.exe", ".env", "../image.png", "deceptive\u202Egnp.txt").forEach {
            assertThrows(IllegalArgumentException::class.java) { FileTransferPolicy.canonicalMime(it, "", false) }
        }
        assertThrows(IllegalArgumentException::class.java) { FileTransferPolicy.canonicalMime("image.png", "text/plain", true) }
        assertEquals("text/plain", FileTransferPolicy.canonicalMime("program.kt", "text/plain", false))
        assertThrows(IllegalArgumentException::class.java) { FileTransferPolicy.canonicalMime("program.kt", "text/plain", true) }
    }
    @Test fun uploadCopyEnforcesBoundEvenWhenProviderSizeIsMissingOrLies() {
        assertThrows(IllegalArgumentException::class.java) { FileTransferPolicy.copyBounded(contents.inputStream(), ByteArrayOutputStream(), 2) }
        assertThrows(IllegalArgumentException::class.java) { FileTransferPolicy.copyBounded(byteArrayOf().inputStream(), ByteArrayOutputStream(), 2) }
        val result = FileTransferPolicy.copyBounded(contents.inputStream(), ByteArrayOutputStream(), 100)
        assertEquals(contents.size.toLong(), result.first)
        assertEquals(digest.joinToString("") { "%02x".format(it) }, result.second)
    }
}
