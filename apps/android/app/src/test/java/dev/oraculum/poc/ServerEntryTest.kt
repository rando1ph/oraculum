package dev.oraculum.poc

import org.junit.Assert.*
import org.junit.Test

class ServerEntryTest {
    private fun entry(origin: String = "https://example.com", path: String = "/", debug: Boolean = false) =
        ServerEntry.parse(origin, path, debug)

    @Test fun normalizesOriginAndBasePathWithoutChangingPathCase() {
        val normalized = entry(" HTTPS://Example.COM:443/ ", " /Workspace ")
        assertEquals("https://example.com", normalized.origin)
        assertEquals("/Workspace/", normalized.basePath)
        assertEquals("https://example.com/Workspace/", normalized.url)
        assertEquals("/", entry(path = " ").basePath)
        assertEquals("https://[::1]:7443/", entry("https://[::1]:7443").url)
    }

    @Test fun rejectsOriginConfusionAndInsecureAddresses() {
        listOf("http://example.com", "file:///private", "javascript:alert(1)", "https://user:pass@example.com",
            "https://example.com/path", "https://example.com?query", "https://example.com#hash", "//example.com",
            "https://example.com:0", "https://example.com:65536", "https://example.com:invalid",
            "https://example.com%2f.evil.test", "https://example.com\\@evil.test", "https://")
            .forEach { raw -> assertThrows(raw, IllegalArgumentException::class.java) { entry(raw) } }
    }

    @Test fun permitsOnlyTheExistingDebugAdbRoot() {
        assertEquals("http://127.0.0.1:17860/", entry(ServerEntry.DEBUG_ORIGIN, debug = true).url)
        assertThrows(IllegalArgumentException::class.java) { entry(ServerEntry.DEBUG_ORIGIN) }
        listOf("http://localhost:17860", "http://127.0.0.1:17861", "http://127.0.0.2:17860")
            .forEach { raw -> assertThrows(raw, IllegalArgumentException::class.java) { entry(raw, debug = true) } }
        assertThrows(IllegalArgumentException::class.java) { entry(ServerEntry.DEBUG_ORIGIN, "/other", true) }
    }

    @Test fun rejectsAmbiguousAndEscapedBasePaths() {
        listOf("relative", "//", "/x//y", "/./", "/x/../y", "/x/%2e%2e/y", "/x%2fy", "/x?y", "/x#y", "/x\\y")
            .forEach { raw -> assertThrows(raw, IllegalArgumentException::class.java) { entry(path = raw) } }
    }

    @Test fun trustsOnlyTheCanonicalOriginAndPathBoundary() {
        val selected = entry(path = "/app")
        listOf("https://example.com/app/", "https://EXAMPLE.com:443/app/assets/main.js", "https://example.com/app/?query=value#hash")
            .forEach { assertTrue(it, selected.trusts(it)) }
        listOf("https://example.com/", "https://example.com/app", "https://example.com/apple/main.js", "https://example.com/App/",
            "https://example.com/app/../sibling", "https://example.com/app/%2e%2e/sibling", "https://example.com/app//file",
            "https://example.com:444/app/", "https://evil.test/app/", "http://example.com/app/",
            "https://user@example.com/app/", "https://example.com.evil.test/app/", "oraculum://settings/server")
            .forEach { assertFalse(it, selected.trusts(it)) }
    }

    @Test fun profilesIsolatePortAndBasePathButKeepCanonicalEquivalentEntries() {
        val original = entry(path = "/app")
        assertEquals(original.profileName, entry("https://EXAMPLE.COM:443/", "/app/").profileName)
        assertNotEquals(original.profileName, entry("https://example.com:444", "/app").profileName)
        assertNotEquals(original.profileName, entry(path = "/other").profileName)
        assertNotEquals(original.profileName, entry(path = "/App").profileName)
        assertTrue(original.usesDefaultProfile("https://example.com/app/"))
        assertFalse(entry(path = "/other").usesDefaultProfile(original.url))
        assertFalse(entry("https://example.com:444", "/app").usesDefaultProfile(original.url))
        assertTrue(original.profileName.matches(Regex("entry-[0-9a-f]{64}")))
    }
}
