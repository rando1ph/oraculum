package dev.oraculum.poc.gateway

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import dev.oraculum.poc.files.HostFileGrant

class GatewayClientTest {
    @Test fun binaryUploadHasPinnedScopeLengthAndNeverRetriesLostAcknowledgement() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            val file = File.createTempFile("attachment", ".txt")
            try {
                file.writeText("test bytes")
                f.binaryResponse = MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                val metadata = buildJsonObject {
                    put("operationId", OPERATION); put("projectId", INSTALLATION); put("threadId", "thread")
                    put("draftId", EPOCH); put("name", "note.txt"); put("mime", "text/plain"); put("size", file.length())
                }
                assertEquals("CONNECTION_LOST", failure { f.client.uploadAttachment(metadata, file, {}) }.code)
                assertEquals(1, f.binaryRequests.get())
                val request = requireNotNull(f.binaryRequest)
                assertEquals("application/octet-stream", request.getHeader("Content-Type"))
                assertEquals(file.length().toString(), request.getHeader("Content-Length"))
                assertEquals(metadata, parse(String(Base64.getUrlDecoder().decode(request.getHeader("X-Oraculum-Upload")))))
                assertEquals("test bytes", request.body.readUtf8())
            } finally { file.delete() }
        }
    }

    @Test fun binaryAuthFailureExpiresSessionWithoutReplayingUpload() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32)); val file = File.createTempFile("attachment", ".txt")
            try {
                file.writeText("x")
                f.binaryResponse = MockResponse().setResponseCode(401).setHeader("Content-Type", "application/json")
                    .setBody("""{"installationId":"$INSTALLATION","epoch":"$EPOCH","requestId":"r","error":{"code":"UNAUTHENTICATED","message":"expired"}}""")
                val metadata = buildJsonObject { put("operationId", OPERATION); put("threadId", "thread"); put("size", 1) }
                assertEquals("ACCESS_EXPIRED", failure { f.client.uploadAttachment(metadata, file, {}) }.code)
                assertEquals(1, f.binaryRequests.get()); f.client.get("projects")
                assertEquals(1, f.tokenRequests.get()); assertEquals(1, f.binaryRequests.get())
            } finally { file.delete() }
        }
    }

    @Test fun downloadChecksDigestAndDeletesUntrustedOrPartialFile() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32)); val target = File.createTempFile("download", ".txt")
            val bytes = "verified result".toByteArray()
            val hash = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes))
            val grant = HostFileGrant(OPERATION, INSTALLATION, null, "result.txt", "result.txt", "text/plain", bytes.size.toLong(), 20_000)
            fun response(body: String) = MockResponse().setHeader("Content-Type", "text/plain").setHeader("Content-Length", bytes.size)
                .setHeader("Content-Digest", "sha-256=:$hash:").setHeader("Content-Disposition", "attachment; filename*=UTF-8''result.txt").setBody(body)
            try {
                f.binaryResponse = response("verified result")
                f.client.downloadFile(grant, target); assertArrayEquals(bytes, target.readBytes())
                f.binaryResponse = response("replaced result")
                try { f.client.downloadFile(grant, target); fail("Digest mismatch must fail") } catch (_: IllegalArgumentException) { }
                assertFalse(target.exists()); assertEquals(2, f.binaryRequests.get())
                f.binaryResponse = response("verified result").setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
                try { f.client.downloadFile(grant, target); fail("Interrupted stream must fail") } catch (_: Exception) { }
                assertFalse(target.exists()); assertEquals(3, f.binaryRequests.get())
            } finally { target.delete() }
        }
    }
    @Test fun endpointRequiresCanonicalHttpsAndPreservesBasePath() {
        assertEquals("https://example.test/service/", GatewayEndpoint.parse(" HTTPS://Example.Test:443/service ").url)
        assertEquals("https://[::1]:8443/", GatewayEndpoint.parse("https://[::1]:8443").url)
        listOf("http://localhost/", "https://user:secret@example.test/", "https://example.test/?token=x",
            "https://example.test/#x", "https://example.test/a//b", "https://example.test/a/../b",
            "https://example.test/%2e%2e/", "https://example.test:0/").forEach {
            assertEquals("INVALID_ENDPOINT", assertThrows(GatewayException::class.java) { GatewayEndpoint.parse(it) }.code)
        }
        listOf("..", "a/b", "%2F", "a?b").forEach { assertThrows(GatewayException::class.java) { GatewayClient.segment(it) } }
    }

    @Test fun persistsIdentityBeforePairAndRecoversLostAcknowledgementWithoutAnotherPair() = runBlocking {
        Fixture().use { f ->
            f.losePairAck = true
            val error = failure { f.client.pair(f.endpoint, "C".repeat(32)) }
            assertEquals("CONNECTION_LOST", error.code)
            assertTrue(f.persistedBeforePair)
            assertEquals(false, f.store.record?.identity?.paired)
            val originalDevice = f.store.record!!.identity.deviceId
            f.client.connect(f.endpoint)
            assertEquals(originalDevice, f.client.identity!!.deviceId)
            assertTrue(f.client.identity!!.paired)
            assertEquals(1, f.pairRequests.get())
            assertEquals(1, f.tokenRequests.get())
            assertEquals("/base/", f.endpoint.basePath)
        }
    }

    @Test fun accessRenewsInMemoryBeforeExpiryAndDoesNotPersistTokens() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            val saved = f.store.record
            f.now += 901
            f.client.get("projects")
            assertEquals(1, f.tokenRequests.get())
            assertSame(saved, f.store.record)
            assertEquals(2, f.store.saves)
            assertFalse(f.store.record!!.secret == "T".repeat(43))
        }
    }

    @Test fun businessWritesAreNeverRetriedAfter401OrRetryable503() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            val device = f.client.identity!!.deviceId
            f.writeStatus = 401
            val expired = failure { f.client.post("projects", operation()) }
            assertEquals("ACCESS_EXPIRED", expired.code)
            assertFalse(expired.authInvalid)
            assertEquals(1, f.writeRequests.get())
            assertEquals(0, f.tokenRequests.get())
            f.client.connect(f.endpoint)
            assertEquals(device, f.client.identity!!.deviceId)
            assertEquals(1, f.tokenRequests.get())
            assertEquals(1, f.pairRequests.get())
            f.writeStatus = 503
            assertEquals("UNAVAILABLE", failure { f.client.post("projects", operation()) }.code)
            assertEquals(2, f.writeRequests.get())
        }
    }

    @Test fun lifecycleIsRecheckedAfterTokenRenewalBeforeBusinessDispatch() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            f.now += 901
            class OfflineBeforeDispatch : Exception()
            try {
                f.client.post("projects", operation()) { throw OfflineBeforeDispatch() }
                fail("Expected the lifecycle guard to stop dispatch")
            } catch (_: OfflineBeforeDispatch) { /* A known local notSent result. */ }
            assertEquals(1, f.tokenRequests.get())
            assertEquals(0, f.writeRequests.get())
        }
    }

    @Test fun oversizedBusinessRequestFailsBeforeDispatchSignal() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            var dispatchSignalled = false
            val oversized = buildJsonObject { put("operationId", OPERATION); put("text", "a".repeat(128 * 1024)) }
            assertEquals("REQUEST_TOO_LARGE", failure {
                f.client.post("projects", oversized) { dispatchSignalled = true }
            }.code)
            assertFalse("Local validation must not leave a durable intent classified as dispatched", dispatchSignalled)
            assertEquals(0, f.writeRequests.get())
        }
    }

    @Test fun authenticationFailureBeforeBusinessEnqueueSettlesOnlyTheOriginalIntent() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            f.now += 901
            f.revoked = true
            var receipt = "unknown"
            val error = failure {
                dev.oraculum.poc.repository.dispatchWriteRequest({ markDispatched ->
                    f.client.post("projects", operation(), markDispatched)
                }, { receipt = "rejected/notSent" })
            }
            assertEquals("DEVICE_REVOKED", error.code)
            assertEquals("rejected/notSent", receipt)
            assertEquals(1, f.tokenRequests.get())
            assertEquals(0, f.writeRequests.get())
            assertEquals(1, f.pairRequests.get())
        }
    }

    @Test fun lostBusinessAcknowledgementRemainsUnknownAndIsNeverRepeated() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            f.loseWriteAck = true
            var receipt = "unknown"
            assertEquals("CONNECTION_LOST", failure {
                dev.oraculum.poc.repository.dispatchWriteRequest({ markDispatched ->
                    f.client.post("projects", operation(), markDispatched)
                }, { receipt = "rejected/notSent" })
            }.code)
            assertEquals("unknown", receipt)
            assertEquals(1, f.writeRequests.get())
        }
    }

    @Test fun incompatibleHealthProtocolStopsBeforePairing() = runBlocking {
        Fixture().use { f ->
            f.protocolMajor = 3
            assertEquals("PROTOCOL_INCOMPATIBLE", failure { f.client.pair(f.endpoint, "C".repeat(32)) }.code)
            assertEquals(0, f.pairRequests.get())
            assertNull(f.store.record)
        }
    }

    @Test fun revokedDeviceDoesNotGenerateReplacementOrRepeatPair() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            val original = f.store.record
            f.client.disconnect()
            f.revoked = true
            val error = failure { f.client.connect(f.endpoint) }
            assertEquals("DEVICE_REVOKED", error.code)
            assertTrue(error.authInvalid)
            assertSame(original, f.store.record)
            assertEquals("DEVICE_REVOKED", failure { f.client.pair(f.endpoint, "D".repeat(32)) }.code)
            assertEquals(1, f.pairRequests.get())
        }
    }

    @Test fun rejectsUnknownReceiptStatusAndWrongInstallation() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            f.writeReceiptStatus = "future-success"
            assertEquals("INVALID_RESPONSE", failure { f.client.post("projects", operation()) }.code)
            f.installation = "00000000-0000-4000-8000-000000000009"
            assertEquals("INSTALLATION_CHANGED", failure { f.client.connect(f.endpoint) }.code)
        }
    }

    @Test fun rejectsWrongCertificateWithoutSendingAuthentication() = runBlocking {
        Fixture().use { f ->
            val untrusted = GatewayClient(f.store, OkHttpClient()) { f.now }
            assertEquals("TLS_REJECTED", failure { untrusted.pair(f.endpoint, "C".repeat(32)) }.code)
            assertEquals(0, f.pairRequests.get())
            assertNull(f.store.record)
        }
    }

    @Test fun rejectsRedirectWithoutForwardingCredential() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            f.redirect = true
            assertEquals("REDIRECT_REJECTED", failure { f.client.get("projects") }.code)
            assertEquals(0, f.redirectRequests.get())
        }
    }

    @Test fun eventsResumeContiguouslyAndFailClosedOnGap() = runBlocking {
        Fixture().use { f ->
            f.client.pair(f.endpoint, "C".repeat(32))
            val failure = CountDownLatch(1)
            val applied = mutableListOf<Long>()
            var errorCode: String? = null
            f.client.openEvents(EventCursor(EPOCH, 5), object : GatewayEventListener {
                override fun onEvent(event: JsonObject) { applied += event.getValue("seq").jsonPrimitive.content.toLong() }
                override fun onFailure(error: GatewayException) { errorCode = error.code; failure.countDown() }
            })
            assertTrue(failure.await(5, TimeUnit.SECONDS))
            assertEquals(listOf(6L), applied)
            assertEquals("EVENT_RESET_REQUIRED", errorCode)
            assertEquals(5L, f.resumeAfter)
        }
    }

    @Test fun unknownCriticalEventsAndMalformedKnownPayloadsInvalidate() {
        fun event(kind: String, payload: String, impact: String = "state") = parse("""{"installationId":"$INSTALLATION","epoch":"$EPOCH","seq":1,"kind":"$kind","scope":{},"impact":"$impact","payload":$payload}""")
        assertEquals(EventDisposition.APPLY, GatewayProtocol.disposition(event("item.delta", """{"delta":"hi"}""")))
        assertEquals(EventDisposition.RESYNCHRONIZE, GatewayProtocol.disposition(event("item.delta", "{}")))
        assertEquals(EventDisposition.RESYNCHRONIZE, GatewayProtocol.disposition(event("future.state", "{}")))
        assertEquals(EventDisposition.SKIP, GatewayProtocol.disposition(event("future.info", "{}", "informational")))
        assertEquals(EventDisposition.RESYNCHRONIZE, GatewayProtocol.disposition(event("operation.changed", """{"operationId":"$OPERATION","status":"future"}""")))
    }

    private class MemoryStore : CredentialStore {
        var record: DeviceCredential? = null
        var saves = 0
        override fun load(endpoint: GatewayEndpoint): DeviceCredential? = record?.takeIf { it.identity.endpoint == endpoint.url }
        override fun save(credential: DeviceCredential) { record = credential; saves++ }
    }

    private class Fixture : AutoCloseable {
        val store = MemoryStore()
        val server = MockWebServer()
        val client: GatewayClient
        val endpoint: GatewayEndpoint
        var now = 10_000L
        var installation = INSTALLATION
        var protocolMajor = 2
        var losePairAck = false
        var loseWriteAck = false
        var persistedBeforePair = false
        var registered: DeviceCredential? = null
        var revoked = false
        var writeStatus = 200
        var writeReceiptStatus = "accepted"
        var redirect = false
        var resumeAfter: Long? = null
        val pairRequests = AtomicInteger()
        val tokenRequests = AtomicInteger()
        val writeRequests = AtomicInteger()
        val redirectRequests = AtomicInteger()
        val binaryRequests = AtomicInteger()
        var binaryResponse = MockResponse().setResponseCode(500)
        var binaryRequest: RecordedRequest? = null

        init {
            val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
            val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
            val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
            server.useHttps(serverTls.sslSocketFactory(), false)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.getHeader("X-Oraculum-Protocol") != "2") return error("PROTOCOL_INCOMPATIBLE", 409)
                    return when (request.path) {
                        "/base/api/v2/threads/thread/attachments", "/base/api/v2/files/$OPERATION/content" -> {
                            binaryRequests.incrementAndGet(); binaryRequest = request; binaryResponse
                        }
                        "/base/health" -> json("""{"status":"ok","protocolMajor":$protocolMajor,"installationId":"$installation"}""")
                        "/base/api/v2/auth/pair" -> {
                            pairRequests.incrementAndGet()
                            val body = parse(request.body.readUtf8())
                            persistedBeforePair = store.record?.identity?.deviceId == body["deviceId"]?.jsonPrimitive?.content &&
                                store.record?.secret == body["deviceCredential"]?.jsonPrimitive?.content
                            registered = store.record
                            if (losePairAck) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else auth()
                        }
                        "/base/api/v2/auth/token" -> {
                            tokenRequests.incrementAndGet()
                            if (revoked) error("DEVICE_REVOKED", 403) else if (registered == null) error("UNAUTHENTICATED", 401) else auth()
                        }
                        "/base/api/v2/capabilities" -> json(resource("""{"protocol":{"major":2,"minor":0,"minClientMinor":0},"gatewayVersion":"2.0.0","installationId":"$installation","epoch":"$EPOCH","codex":{"version":null,"connectionState":"connected"},"capabilities":[],"limits":{"requestBytes":131072,"historyPageItems":20,"attachmentFileBytes":1,"attachmentBatchBytes":1,"attachmentBatchCount":1,"eventReplayCount":1024}}"""))
                        "/base/api/v2/projects" -> if (request.method == "GET") {
                            if (redirect) MockResponse().setResponseCode(302).addHeader("Location", "/redirect")
                            else json(resource("""{"projects":[],"roots":[]}"""))
                        } else {
                            writeRequests.incrementAndGet()
                            if (loseWriteAck) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                            else if (writeStatus != 200) error(if (writeStatus == 401) "UNAUTHENTICATED" else "UNAVAILABLE", writeStatus).addHeader("Retry-After", "0")
                            else json("""{"installationId":"$installation","epoch":"$EPOCH","requestId":"request","operation":{"operationId":"$OPERATION","status":"$writeReceiptStatus"}}""")
                        }
                        "/base/api/v2/events" -> MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                            override fun onMessage(webSocket: WebSocket, text: String) {
                                val message = parse(text)
                                if (message["type"]?.jsonPrimitive?.content != "resume") return
                                resumeAfter = message.getValue("afterSeq").jsonPrimitive.content.toLong()
                                webSocket.send("""{"type":"connection","installationId":"$installation","epoch":"$EPOCH","headSeq":8,"resetRequired":false}""")
                                listOf(6, 6, 8).forEach { seq -> webSocket.send("""{"installationId":"$installation","epoch":"$EPOCH","seq":$seq,"kind":"item.delta","impact":"state","scope":{},"payload":{"delta":"test"}}""") }
                            }
                        })
                        "/redirect" -> { redirectRequests.incrementAndGet(); json("{}") }
                        else -> error("NOT_FOUND", 404)
                    }
                }
            }
            server.start()
            endpoint = GatewayEndpoint.parse(server.url("/base/").toString())
            client = GatewayClient(store, OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager).build()) { now }
        }

        private fun auth() = json("""{"installationId":"$installation","deviceId":"${registered!!.identity.deviceId}","accessToken":"${"T".repeat(43)}","expiresAt":${now + 1000}}""")
        private fun resource(data: String) = """{"installationId":"$installation","epoch":"$EPOCH","requestId":"request","data":$data}"""
        private fun error(code: String, status: Int) = json("""{"installationId":"$installation","epoch":"$EPOCH","requestId":"request","error":{"code":"$code","message":"synthetic error"}}""").setResponseCode(status)
        private fun json(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(value)
        override fun close() { client.disconnect(); server.shutdown() }
    }

    companion object {
        private const val INSTALLATION = "00000000-0000-4000-8000-000000000001"
        private const val EPOCH = "00000000-0000-4000-8000-000000000002"
        private const val OPERATION = "00000000-0000-4000-8000-000000000003"
        private fun parse(text: String) = GatewayProtocol.json.parseToJsonElement(text).jsonObject
        private fun operation() = buildJsonObject { put("operationId", OPERATION) }
        private suspend fun failure(block: suspend () -> Any?): GatewayException {
            try { block() } catch (error: GatewayException) { return error }
            throw AssertionError("Expected a safe Gateway failure")
        }
    }
}
