package dev.oraculum.poc.files

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class PreviewCacheTest {
    @Test fun cleansOnlyExpiredOwnedFilesAndProtectsActiveAndRecentShares() {
        val root = Files.createTempDirectory("preview-cache").toFile()
        var now = 10_000L
        val cache = PreviewCache(root, { now }, budgetBytes = 100, leaseMillis = 1000)
        fun file(name: String = UUID.randomUUID().toString() + ".download", stamp: Long = 1L) =
            File(root, name).apply { writeText("bytes"); assertTrue(setLastModified(stamp)) }
        val expired = file(); val active = file(); val shared = file(); val unrelated = file("keep-user.txt")
        val outside = File(root.parentFile, "outside-${UUID.randomUUID()}").apply { writeText("untouched") }
        val link = File(root, UUID.randomUUID().toString() + ".download")
        try {
            Files.createSymbolicLink(link.toPath(), outside.toPath())
            cache.retain(shared)
            cache.clean(setOf(active))
            assertFalse(expired.exists()); assertTrue(active.exists()); assertTrue(shared.exists()); assertTrue(unrelated.exists())
            assertTrue(Files.isSymbolicLink(link.toPath())); assertEquals("untouched", outside.readText())
            now += 1001
            cache.clean(setOf(active))
            assertFalse(shared.exists()); assertTrue(active.exists()); assertTrue(unrelated.exists())
        } finally { link.delete(); root.deleteRecursively(); outside.delete() }
    }

    @Test fun fullBudgetRejectsNewDownloadWithoutEvictingRecentSharedBytes() {
        val root = Files.createTempDirectory("preview-budget").toFile()
        var now = 10_000L
        val cache = PreviewCache(root, { now }, budgetBytes = 100, leaseMillis = 1000)
        try {
            val first = cache.reserve(60, emptySet()).apply { writeBytes(ByteArray(60)); cache.retain(this) }
            val second = cache.reserve(40, setOf(first)).apply { writeBytes(ByteArray(40)); cache.retain(this) }
            assertThrows(PreviewCacheFullException::class.java) { cache.reserve(1, setOf(first)) }
            assertEquals(60L, first.length()); assertEquals(40L, second.length())
            now += 1001
            val third = cache.reserve(40, setOf(first))
            assertTrue(third.isFile); assertTrue(first.exists()); assertFalse(second.exists())
        } finally { root.deleteRecursively() }
    }

    @Test fun zeroBytePreviewsStillRespectFileCountAndClockRollbackCannotExpireShares() {
        val root = Files.createTempDirectory("preview-count").toFile()
        var now = 10_000L
        val cache = PreviewCache(root, { now }, budgetBytes = 100, leaseMillis = 1000, maxFiles = 2)
        try {
            val files = List(2) { cache.reserve(0, emptySet()).also(cache::retain) }
            now = 1
            assertThrows(PreviewCacheFullException::class.java) { cache.reserve(0, emptySet()) }
            assertTrue(files.all(File::exists))
        } finally { root.deleteRecursively() }
    }
}
