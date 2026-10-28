package dev.oraculum.poc

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.security.MessageDigest

class ArtifactDownloadPolicyTest {
    private val id = "12345678-1234-4234-8234-123456789abc"
    private val data = "合成成果".toByteArray(Charsets.UTF_8)
    private val digest = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    private fun disposition(name: String) = "attachment; filename=\"artifact.${name.substringAfterLast('.')}\"; filename*=UTF-8''" + URLEncoder.encode(name, "UTF-8").replace("+", "%20")
    private fun rejected(work: () -> Unit) { try { work(); fail("Must reject invalid capability or transfer") } catch (_: IllegalArgumentException) { } }

    @Test fun exactGestureRouteHasNoUrlCredentialOrArbitraryPath() {
        for (mode in listOf("save", "share", "open")) assertEquals(ArtifactDownloadPolicy.Action(mode, id), ArtifactDownloadPolicy.action("oraculum://artifact/$mode/$id"))
        for (raw in listOf("oraculum://artifact/save/$id?token=secret", "oraculum://artifact/save/$id#fragment", "oraculum://artifact/save/../etc/passwd",
            "oraculum://artifact/save/%2e%2e", "oraculum://artifact/delete/$id", "https://host/artifact/save/$id", "oraculum://artifact/save/$id/", "oraculum://artifact/save/forged")) assertNull(ArtifactDownloadPolicy.action(raw))
    }
    @Test fun scopedProfileCookieCopiesOnlyOneExpectedCredential() {
        val remote = ServerEntry.parse("https://example.com", "/console/", false)
        val credential = "__Secure-oraculum_session=" + "x".repeat(43)
        assertEquals(credential, ArtifactDownloadPolicy.cookie("other=private; $credential; ignored=secret", remote))
        for (raw in listOf(null, "oraculum_local=" + "x".repeat(43), "$credential; $credential", "__Secure-oraculum_session=short", credential + "\r\nX-Injected: true")) assertNull(ArtifactDownloadPolicy.cookie(raw, remote))
        val local = ServerEntry.parse(ServerEntry.DEBUG_ORIGIN, "/", true)
        assertNull(ArtifactDownloadPolicy.cookie(credential, local))
        assertNotNull(ArtifactDownloadPolicy.cookie("oraculum_local=" + "x".repeat(43), local))
    }
    @Test fun exactTypesNamesSizesAndDigestRequired() {
        for ((extension, mime) in listOf("pdf" to "application/pdf", "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "png" to "image/png", "txt" to "text/plain", "md" to "text/markdown")) {
            val name = "中文成果（合成）.$extension"
            assertEquals(name, ArtifactDownloadPolicy.metadata(mime, "1", disposition(name), digest).name)
        }
        for (name in listOf("../x.txt", ".env.txt", "folder/x.txt", "folder\\x.txt", "bad\u202etxt.txt", "bad\u0000.txt", "bad%2etxt.txt", " x.txt")) rejected {
            ArtifactDownloadPolicy.metadata("text/plain", "1", disposition(name), digest)
        }
        for (length in listOf(null, "-1", "999999999999999999999999999", (ArtifactDownloadPolicy.maxBytes + 1).toString())) rejected { ArtifactDownloadPolicy.metadata("text/plain", length, disposition("x.txt"), digest) }
        rejected { ArtifactDownloadPolicy.metadata("text/html", "1", disposition("x.txt"), digest) }
        rejected { ArtifactDownloadPolicy.metadata("image/png", "1", disposition("x.svg"), digest) }
        rejected { ArtifactDownloadPolicy.metadata("text/plain", "1", "inline; filename=x.txt", digest) }
        rejected { ArtifactDownloadPolicy.metadata("text/plain", "1", disposition("x.txt"), "bad") }
    }
    @Test fun completeByteTransferWithProgressAndIntegrity() {
        val metadata = ArtifactDownloadPolicy.Metadata("成果.txt", "text/plain", data.size.toLong(), digest)
        val output = ByteArrayOutputStream(); var progress = 0L
        ArtifactDownloadPolicy.copy(ByteArrayInputStream(data), output, metadata, { false }) { progress = it }
        assertArrayEquals(data, output.toByteArray()); assertEquals(data.size.toLong(), progress)
        val emptyHash = MessageDigest.getInstance("SHA-256").digest(ByteArray(0)).joinToString("") { "%02x".format(it) }
        ArtifactDownloadPolicy.copy(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream(), metadata.copy(size = 0, digest = emptyHash), { false }) { }
    }
    @Test fun truncationOversizeWrongDigestAndCancelNeverComplete() {
        val metadata = ArtifactDownloadPolicy.Metadata("x.txt", "text/plain", data.size.toLong(), digest)
        rejected { ArtifactDownloadPolicy.copy(ByteArrayInputStream(data.copyOf(data.size - 1)), ByteArrayOutputStream(), metadata, { false }) { } }
        rejected { ArtifactDownloadPolicy.copy(ByteArrayInputStream(data + byteArrayOf(1)), ByteArrayOutputStream(), metadata, { false }) { } }
        rejected { ArtifactDownloadPolicy.copy(ByteArrayInputStream(data), ByteArrayOutputStream(), metadata.copy(digest = "0".repeat(64)), { false }) { } }
        val output = ByteArrayOutputStream()
        try { ArtifactDownloadPolicy.copy(ByteArrayInputStream(data), output, metadata, { true }) { }; fail("Cancelled copy must not finish") } catch (_: IllegalStateException) { }
        assertEquals(0, output.size())
    }
}
