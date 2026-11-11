package dev.oraculum.poc.repository

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeInteractionFormsTest {
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun interaction(kind: String = "command", request: JsonObject = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","command":"pwd"}"""), status: String = "pending") =
        NativeInteractionForms.parse(buildJsonObject {
            put("interactionId", "interaction-1"); put("projectId", "project-1"); put("threadId", "thread-1")
            put("epoch", "epoch-1"); put("generation", 3); put("kind", kind); put("status", status); put("request", request)
        })
    private fun approval(decision: String) = buildJsonObject { put("type", "approval"); put("decision", decision) }
    private fun elicitation(schema: JsonElement) = interaction("elicitation", buildJsonObject {
        put("threadId", "thread-1"); put("turnId", JsonNull); put("serverName", "Native MCP"); put("message", "Please confirm")
        put("mode", "form"); put("requestedSchema", schema)
    })
    private fun accepted(content: JsonElement) = buildJsonObject { put("type", "elicitation"); put("action", "accept"); put("content", content) }
    private fun schema(properties: JsonObject, required: List<String> = emptyList()) = buildJsonObject {
        put("type", "object"); put("properties", properties); put("required", JsonArray(required.map(::JsonPrimitive)))
    }

    @Test fun nativeApprovalIntersectionDoesNotInventSessionOrPolicyGrants() {
        val request = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","command":"pwd","availableDecisions":["decline","acceptForSession",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git"]}},"cancel"]}""")
        val value = interaction(request = request)
        assertTrue(value.supported)
        assertEquals(listOf("decline", "cancel"), value.decisions)
        assertFalse(NativeInteractionForms.validate(value, approval("accept")))
        assertTrue(NativeInteractionForms.validate(value, approval("decline")))
        assertFalse(NativeInteractionForms.validate(value, approval("acceptForSession")))
    }

    @Test fun nativeApprovalAbsenceHasOnlyGatewaySupportedDecisions() {
        assertEquals(listOf("accept", "decline", "cancel"), interaction().decisions)
        assertTrue(NativeInteractionForms.validate(interaction(), approval("accept")))
        assertFalse(NativeInteractionForms.validate(interaction(), obj("""{"type":"approval","decision":"accept","permanent":true}""")))
    }

    @Test fun requestWithOnlyUnsupportedDecisionsHasNoResponseButtons() {
        val request = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","availableDecisions":["acceptForSession"]}""")
        val value = interaction(request = request)
        assertFalse(value.supported)
        assertEquals(emptyList<String>(), value.decisions)
        assertFalse(NativeInteractionForms.validate(value, approval("accept")))
    }

    @Test fun submittedUnknownAndResolvedInteractionsCannotBeResent() {
        listOf("submitted", "unknown", "resolved").forEach { status ->
            assertFalse(NativeInteractionForms.validate(interaction(status = status), approval("accept")))
        }
    }

    @Test fun malformedEnvelopeAndRequestCannotBecomeActionable() {
        assertFalse(NativeInteractionForms.parse(obj("""{"kind":"command","status":"pending","request":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}}""")).supported)
        assertFalse(interaction(request = obj("""{"threadId":"other-thread","turnId":"turn-1","itemId":"item-1"}""")).supported)
        assertFalse(interaction(request = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","availableDecisions":[true]}""")).supported)
    }

    @Test fun permissionsPreserveTurnScopeAndRejectUnknownStructuredPaths() {
        val good = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","cwd":"/project","permissions":{"network":{"enabled":true},"fileSystem":{"read":["/project"],"write":["/project/output"]}}}""")
        assertTrue(interaction("permissions", good).supported)
        assertTrue(NativeInteractionForms.validate(interaction("permissions", good), approval("accept")))
        val structured = JsonObject(good + ("permissions" to obj("""{"fileSystem":{"write":[{"glob":"/**"}]}}""")))
        assertFalse(interaction("permissions", structured).supported)
        val relative = JsonObject(good + ("permissions" to obj("""{"fileSystem":{"write":["../outside"]}}""")))
        assertFalse(interaction("permissions", relative).supported)
    }

    private val inputRequest = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","isBlocking":true,"questions":[{"id":"choice","header":"Choose","question":"Which?","options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]},{"id":"secret","header":"Token","question":"Credential","isSecret":true}]}""")

    @Test fun inputOnlyAcceptsDeclaredQuestionsOptionsAndStringValues() {
        val value = interaction("input", inputRequest)
        assertTrue(value.supported)
        assertTrue(value.questions[1].isSecret)
        assertTrue(NativeInteractionForms.validate(value, obj("""{"type":"input","answers":{"choice":["A"],"secret":["typed value"]}}""")))
        assertFalse(NativeInteractionForms.validate(value, obj("""{"type":"input","answers":{"choice":["C"]}}""")))
        assertFalse(NativeInteractionForms.validate(value, obj("""{"type":"input","answers":{"unknown":["A"]}}""")))
        assertFalse(NativeInteractionForms.validate(value, obj("""{"type":"input","answers":{"choice":[true]}}""")))
        assertFalse(NativeInteractionForms.validate(value, obj("""{"type":"input","answers":{},"force":true}""")))
    }

    @Test fun otherInputRequiresNativeOptInAndDuplicateQuestionIdsFailClosed() {
        val question = obj("""{"id":"choice","header":"Choose","question":"Which?","isOther":true,"options":[{"label":"A","description":"First"}]}""")
        val request = JsonObject(inputRequest + ("questions" to JsonArray(listOf(question))))
        assertTrue(NativeInteractionForms.validate(interaction("input", request), obj("""{"type":"input","answers":{"choice":["Custom"]}}""")))
        assertFalse(interaction("input", JsonObject(request + ("questions" to JsonArray(listOf(question, question))))).supported)
    }

    @Test fun inputBoundsUseNativeUtf8PayloadAndPerAnswerLimits() {
        val value = interaction("input", inputRequest)
        fun answers(values: List<String>) = buildJsonObject { put("type", "input"); put("answers", buildJsonObject {
            put("secret", JsonArray(values.map(::JsonPrimitive)))
        }) }
        assertFalse(NativeInteractionForms.validate(value, answers(List(21) { "value" })))
        assertFalse(NativeInteractionForms.validate(value, answers(listOf("a".repeat(16_001)))))
        assertFalse(NativeInteractionForms.validate(value, answers(List(10) { "字".repeat(16_000) })))
    }

    @Test fun schemaRejectsUnknownConstraintsInsteadOfWeakeningThem() {
        listOf(
            """{"type":"string","pattern":"^safe$"}""",
            """{"type":"number","exclusiveMinimum":1}""",
            """{"type":"array","items":{"type":"string"}}""",
            """{"type":"object","properties":{}}""",
            """{"type":"string","oneOf":[{"const":"yes","title":"Yes","extra":true}]}""",
        ).forEach { property -> assertNull(NativeInteractionForms.elicitationFields(schema(buildJsonObject { put("field", obj(property)) }))) }
        assertNull(NativeInteractionForms.elicitationFields(obj("""{"type":"object","properties":{},"required":["missing"]}""")))
        assertNull(NativeInteractionForms.elicitationFields(obj("""{"type":"object","properties":{},"additionalProperties":{"type":"string"}}""")))
    }

    @Test fun fieldsPreserveAllTypedConstraintsDefaultsAndLabels() {
        val value = schema(obj("""{"name":{"type":"string","title":"Display name","description":"Unicode name","minLength":1,"maxLength":3,"default":"甲"},"age":{"type":"integer","minimum":0,"maximum":120},"enabled":{"type":"boolean","default":false},"choice":{"type":"string","enum":["a","b"],"enumNames":["Alpha","Beta"]},"items":{"type":"array","minItems":1,"maxItems":2,"items":{"anyOf":[{"const":"one","title":"One"},{"const":"two","title":"Two"}]}}}"""), listOf("name", "age"))
        val fields = NativeInteractionForms.elicitationFields(value)!!
        assertEquals("Display name", fields[0].label)
        assertTrue(fields[0].required)
        assertEquals(3L, fields[0].maxLength)
        assertEquals(JsonPrimitive("甲"), fields[0].defaultValue)
        assertEquals(120.0, fields[1].maximum!!, 0.0)
        assertEquals(JsonPrimitive(false), fields[2].defaultValue)
        assertEquals("Beta", fields[3].options!![1].label)
        assertEquals(2L, fields[4].maxItems)
    }

    @Test fun invalidDefaultsAndConstraintTypesRejectTheEntireSchema() {
        listOf(
            """{"type":"integer","default":"3"}""",
            """{"type":"integer","default":1.5}""",
            """{"type":"string","minLength":2,"default":"a"}""",
            """{"type":"string","minLength":-1}""",
            """{"type":"string","maxLength":1.5}""",
            """{"type":"number","maximum":"4"}""",
            """{"type":"boolean","default":"false"}""",
            """{"type":"string","enum":["a"],"enumNames":["a","b"]}""",
            """{"type":"string","enum":["a"],"oneOf":[{"const":"a","title":"A"}]}""",
        ).forEach { property -> assertNull(NativeInteractionForms.elicitationFields(schema(buildJsonObject { put("field", obj(property)) }))) }
    }

    @Test fun typedContentRejectsMissingUnknownCoercedAndOutOfRangeValues() {
        val schema = schema(obj("""{"age":{"type":"integer","minimum":1,"maximum":5},"ok":{"type":"boolean"},"name":{"type":"string","minLength":1,"maxLength":2}}"""), listOf("age", "ok", "name"))
        val value = elicitation(schema)
        assertTrue(value.supported)
        assertTrue(NativeInteractionForms.validate(value, accepted(obj("""{"age":3,"ok":false,"name":"😀甲"}"""))))
        listOf(
            """{"age":"3","ok":true,"name":"a"}""",
            """{"age":3.1,"ok":true,"name":"a"}""",
            """{"age":6,"ok":true,"name":"a"}""",
            """{"age":3,"ok":"false","name":"a"}""",
            """{"age":3,"ok":false,"name":"abc"}""",
            """{"age":3,"ok":false}""",
            """{"age":3,"ok":false,"name":"a","extra":true}""",
        ).forEach { assertFalse(NativeInteractionForms.validate(value, accepted(obj(it)))) }
    }

    @Test fun arraysRequireUniqueDeclaredOptionsAndItemCount() {
        val schema = schema(obj("""{"choices":{"type":"array","items":{"type":"string","enum":["a","b"]},"minItems":1,"maxItems":2}}"""), listOf("choices"))
        assertTrue(NativeInteractionForms.validElicitationContent(schema, obj("""{"choices":["a","b"]}""")))
        listOf("""{"choices":[]}""", """{"choices":["a","a"]}""", """{"choices":["c"]}""", """{"choices":[true]}""", """{"choices":"a"}""")
            .forEach { assertFalse(NativeInteractionForms.validElicitationContent(schema, obj(it))) }
    }

    @Test fun stringFormatsValidateActualDatesTimesAndUris() {
        fun valid(format: String, value: String) = NativeInteractionForms.validFieldValue(ElicitationFieldUi("id", "label", type = "string", format = format), JsonPrimitive(value))
        assertTrue(valid("email", "name@example.com")); assertFalse(valid("email", "name @example.com"))
        assertTrue(valid("uri", "urn:example:doc")); assertFalse(valid("uri", "/relative/path"))
        assertTrue(valid("date", "2024-02-29")); assertFalse(valid("date", "2025-02-29"))
        assertTrue(valid("date-time", "2026-11-12T00:12:01+08:00")); assertFalse(valid("date-time", "2026-11-12 00:12:01"))
    }

    @Test fun nullSchemaSupportsMessageOnlyConsentAndNonAcceptMustNotCarryContent() {
        val value = elicitation(JsonNull)
        assertTrue(value.supported)
        assertTrue(NativeInteractionForms.validate(value, accepted(JsonNull)))
        assertTrue(NativeInteractionForms.validate(value, accepted(obj("{}"))))
        assertFalse(NativeInteractionForms.validate(value, accepted(obj("""{"invented":true}"""))))
        assertTrue(NativeInteractionForms.validate(value, obj("""{"type":"elicitation","action":"decline","content":null}""")))
        assertFalse(NativeInteractionForms.validate(value, obj("""{"type":"elicitation","action":"decline","content":{}}""")))
    }

    @Test fun urlModeOnlyAllowsCredentialFreeHttpUrlsAndNullContent() {
        fun request(url: String) = buildJsonObject {
            put("threadId", "thread-1"); put("turnId", JsonNull); put("serverName", "MCP"); put("message", "Open link")
            put("mode", "url"); put("elicitationId", "elicitation-1"); put("url", url)
        }
        val value = interaction("elicitation", request("https://example.com/consent"))
        assertTrue(value.supported)
        assertEquals("https://example.com/consent", value.url)
        assertTrue(NativeInteractionForms.validate(value, accepted(JsonNull)))
        assertFalse(NativeInteractionForms.validate(value, accepted(obj("{}"))))
        listOf("javascript:alert(1)", "file:///tmp/private", "https://user:secret@example.com", "https:///missing").forEach {
            assertFalse(interaction("elicitation", request(it)).supported)
        }
    }

    @Test fun commandApprovalRequiresRenderedActionAndDoesNotTreatTerminalInputAsCommand() {
        val base = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","command":"pwd"}""")
        assertTrue(interaction(request = base).supported) // Stable native default for older servers.
        assertTrue(interaction(request = JsonObject(base + ("kind" to JsonPrimitive("command")))).supported)
        listOf("writeStdin", "humanCommand", "futureKind").forEach { kind ->
            val value = interaction(request = JsonObject(base + ("kind" to JsonPrimitive(kind))))
            assertFalse(value.supported)
            assertFalse(NativeInteractionForms.validate(value, approval("accept")))
        }
        assertFalse(interaction(request = JsonObject(base + ("kind" to JsonNull))).supported)
        listOf(JsonNull, JsonPrimitive(""), JsonPrimitive("  ")).forEach { command ->
            assertFalse(interaction(request = JsonObject(base + ("command" to command))).supported)
        }
        assertFalse(interaction(request = JsonObject(base - "command")).supported)
    }

    @Test fun networkApprovalWithoutCommandRetainsExplicitHostAndProtocol() {
        for (protocol in listOf("http", "https", "socks5Tcp", "socks5Udp")) {
            val request = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","kind":"command","command":null,"networkApprovalContext":{"host":"example.com","protocol":"$protocol"}}""")
            val value = interaction(request = request)
            assertTrue(value.supported)
            assertEquals("网络访问审批", value.title)
            val details = NativeInteractionForms.commandApprovalDetails(request)!!
            assertNull(details.command)
            assertEquals("example.com", details.networkHost)
            assertEquals(protocol, details.networkProtocol)
            assertTrue(NativeInteractionForms.validate(value, approval("accept")))
        }
    }

    @Test fun unsupportedNetworkContextCannotBeHiddenByAnOtherwiseValidCommand() {
        val base = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","command":"curl https://example.com"}""")
        listOf(
            """{}""", """{"host":"example.com"}""", """{"host":"example.com","protocol":"futureProtocol"}""",
            """{"host":"","protocol":"https"}""", """{"host":"two hosts","protocol":"https"}""",
            """{"host":"example.com","protocol":"https","port":443}""",
        ).forEach { network ->
            val value = interaction(request = JsonObject(base + ("networkApprovalContext" to obj(network))))
            assertFalse(value.supported)
            assertFalse(NativeInteractionForms.validate(value, approval("accept")))
        }
    }

    @Test fun pendingPreflightFailureCanBeExplicitlyRetriedButUnknownAndSubmittedCannot() {
        val pending = interaction()
        assertTrue(NativeInteractionForms.canRespond(pending, enabled = true))
        assertFalse(NativeInteractionForms.canRespond(pending, enabled = false)) // Real ViewModel busy/preflight.
        assertTrue(NativeInteractionForms.canRespond(pending, enabled = true)) // Preflight ended, no write reserved.
        assertFalse(NativeInteractionForms.canRespond(pending, enabled = false)) // Unresolved operation barrier.
        for (status in listOf("submitted", "unknown", "resolved")) {
            assertFalse(NativeInteractionForms.canRespond(pending.copy(status = status), enabled = true))
        }
    }

    @Test fun fileChangeWithoutVerifiedItemContextSupportsOnlyRefusal() {
        val value = interaction("fileChange", obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}"""))
        assertTrue(value.supported)
        assertEquals(listOf("decline", "cancel"), value.decisions)
        assertFalse(NativeInteractionForms.validate(value, approval("accept")))
        assertTrue(NativeInteractionForms.validate(value, approval("decline")))
        assertTrue(NativeInteractionForms.validate(value, approval("cancel")))
    }

    @Test fun fileChangeReasonGrantRootAndUnboundDiffAreNotApprovalEvidence() {
        val value = interaction("fileChange", obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","reason":"Update docs","grantRoot":"/project","changes":[{"path":"safe.md","diff":"+safe"}]}"""))
        assertFalse("Opaque request additions cannot establish a verified Item association", NativeInteractionForms.validate(value, approval("accept")))
        assertFalse("A forged UI choice cannot bypass the validator", NativeInteractionForms.validate(value.copy(decisions = listOf("accept")), approval("accept")))
    }

    @Test fun fileChangeRefusalNeverInventsANativeDecision() {
        val request = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","availableDecisions":["accept","cancel"]}""")
        val value = interaction("fileChange", request)
        assertEquals(listOf("cancel"), value.decisions)
        assertFalse(NativeInteractionForms.validate(value, approval("decline")))
        assertTrue(NativeInteractionForms.validate(value, approval("cancel")))
        val acceptOnly = interaction("fileChange", JsonObject(request + ("availableDecisions" to JsonArray(listOf(JsonPrimitive("accept"))))))
        assertFalse(acceptOnly.supported)
        assertTrue(acceptOnly.decisions.isEmpty())
        assertFalse(NativeInteractionForms.validate(acceptOnly, approval("accept")))
    }

    @Test fun fileChangeRefusalRequiresValidPendingIdentity() {
        val request = obj("""{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}""")
        assertFalse(interaction("fileChange", JsonObject(request - "itemId")).supported)
        for (status in listOf("submitted", "unknown", "resolved")) {
            assertFalse(NativeInteractionForms.validate(interaction("fileChange", request, status), approval("cancel")))
        }
    }

    private val fileScope = FileChangeApprovalScope("epoch-1", "project-1", "thread-1")
    private fun fileEnvelope(
        scope: FileChangeApprovalScope = fileScope,
        turnId: String = "turn-1",
        itemId: String = "item-1",
        nativeDecisions: List<String>? = null,
    ) = buildJsonObject {
        put("interactionId", "interaction-1"); put("projectId", scope.projectId); put("threadId", scope.threadId)
        put("epoch", scope.epoch); put("generation", 3); put("kind", "fileChange"); put("status", "pending")
        put("request", buildJsonObject {
            put("threadId", scope.threadId); put("turnId", turnId); put("itemId", itemId)
            nativeDecisions?.let { put("availableDecisions", JsonArray(it.map(::JsonPrimitive))) }
        })
    }
    private fun fileHistory(
        scope: FileChangeApprovalScope = fileScope,
        turnId: String = "turn-1",
        itemId: String = "item-1",
        diff: String = "@@ -1 +1 @@\n-before\n+after\n",
        truncated: Boolean = false,
    ) = buildJsonObject {
        put("epoch", scope.epoch); put("truncated", truncated)
        put("items", buildJsonArray {
            add(buildJsonObject {
                put("id", turnId); put("status", "inProgress")
                put("items", buildJsonArray {
                    add(buildJsonObject {
                        put("id", itemId); put("type", "fileChange"); put("status", "inProgress")
                        put("changes", buildJsonArray {
                            add(buildJsonObject {
                                put("path", "/project/notes.md")
                                put("kind", buildJsonObject { put("type", "update"); put("move_path", JsonNull) })
                                put("diff", diff)
                            })
                        })
                    })
                })
            })
        })
    }
    private fun verifiedFileContext(
        scope: FileChangeApprovalScope = fileScope,
        turnId: String = "turn-1",
        itemId: String = "item-1",
        diff: String = "@@ -1 +1 @@\n-before\n+after\n",
    ): FileChangeApprovalContext {
        val store = FileChangeApprovalContexts()
        store.snapshot(scope, fileHistory(scope, turnId, itemId, diff))
        return requireNotNull(store.forInteraction(NativeInteractionForms.parse(fileEnvelope(scope, turnId, itemId))))
    }

    @Test fun completeMatchingNativeFileItemEnablesAcceptOnlyRequest() {
        val envelope = fileEnvelope(nativeDecisions = listOf("accept"))
        val pending = NativeInteractionForms.parse(envelope)
        assertFalse(pending.supported)
        assertFalse(NativeInteractionForms.validate(pending, approval("accept")))
        val context = verifiedFileContext()
        val bound = NativeInteractionForms.bindFileChangeContext(pending, context)
        val parsed = NativeInteractionForms.parse(envelope, context)
        for (value in listOf(bound, parsed)) {
            assertTrue(value.supported)
            assertEquals(listOf("accept"), value.decisions)
            assertTrue(NativeInteractionForms.validate(value, approval("accept")))
            assertFalse(NativeInteractionForms.validate(value, approval("cancel")))
        }
        assertEquals("/project/notes.md", context.changes.single().path)
        assertEquals("update", context.changes.single().kind)
        assertEquals("@@ -1 +1 @@\n-before\n+after\n", context.changes.single().diff)
        assertTrue(context.matchesPending(bound, context.digest))
    }

    @Test fun verifiedFileProofCannotCrossEpochProjectThreadTurnOrItem() {
        val pending = NativeInteractionForms.parse(fileEnvelope())
        val mismatches = listOf(
            verifiedFileContext(scope = fileScope.copy(epoch = "epoch-2")),
            verifiedFileContext(scope = fileScope.copy(projectId = "project-2")),
            verifiedFileContext(scope = fileScope.copy(threadId = "thread-2")),
            verifiedFileContext(turnId = "turn-2"),
            verifiedFileContext(itemId = "item-2"),
        )
        for (context in mismatches) {
            assertFalse(context.matchesPending(pending, context.digest))
            val bound = NativeInteractionForms.bindFileChangeContext(pending, context)
            assertFalse("Mismatched proof cannot add acceptance", "accept" in bound.decisions)
            assertFalse(NativeInteractionForms.validate(bound, approval("accept")))
            assertTrue("Native refusal remains available", NativeInteractionForms.validate(bound, approval("cancel")))
        }
    }

    @Test fun proofDoesNotInventNativeApprovalChoiceOrTrustForgedUiChoices() {
        val pending = NativeInteractionForms.parse(fileEnvelope(nativeDecisions = listOf("cancel")))
        val bound = NativeInteractionForms.bindFileChangeContext(pending, verifiedFileContext())
        assertEquals(listOf("cancel"), bound.decisions)
        assertTrue(NativeInteractionForms.validate(bound, approval("cancel")))
        assertFalse(NativeInteractionForms.validate(bound, approval("accept")))
        assertFalse(NativeInteractionForms.validate(bound.copy(decisions = listOf("accept")), approval("accept")))
        val noProof = NativeInteractionForms.parse(fileEnvelope(nativeDecisions = listOf("accept")))
        assertFalse(NativeInteractionForms.validate(noProof.copy(supported = true, decisions = listOf("accept")), approval("accept")))
    }

    @Test fun sameGenerationPatchChangeRejectsDisplayedDigestUntilNewPatchIsReviewed() {
        val pending = NativeInteractionForms.parse(fileEnvelope())
        val first = verifiedFileContext()
        val changed = verifiedFileContext(diff = "@@ -1 +1 @@\n-before\n+different change\n")
        val displayed = NativeInteractionForms.bindFileChangeContext(pending, first)
        val current = NativeInteractionForms.bindFileChangeContext(pending, changed)
        assertEquals(displayed.generation, current.generation)
        assertNotEquals(first.digest, changed.digest)
        assertTrue(fileChangeApprovalStillCurrent(displayed, displayed, first.digest))
        assertFalse(changed.matchesPending(current, first.digest))
        assertFalse(fileChangeApprovalStillCurrent(displayed, current, first.digest))
        assertTrue(fileChangeApprovalStillCurrent(current, current, changed.digest))
        assertFalse(fileChangeApprovalStillCurrent(current, current, null))
        assertFalse(fileChangeApprovalStillCurrent(current, current.copy(generation = current.generation + 1), changed.digest))
        assertFalse(fileChangeApprovalStillCurrent(current, current.copy(id = "replacement-interaction"), changed.digest))
    }

    @Test fun validPatchProofDoesNotAuthorizeResolvedRequestsOrMutatedScope() {
        val context = verifiedFileContext()
        val bound = NativeInteractionForms.parse(fileEnvelope(), context)
        for (status in listOf("submitted", "unknown", "resolved")) {
            val current = bound.copy(status = status)
            assertFalse(context.matchesPending(current, context.digest))
            assertFalse(NativeInteractionForms.validate(current, approval("accept")))
            assertFalse(fileChangeApprovalStillCurrent(bound, current, context.digest))
        }
        val changed = listOf(
            bound.copy(epoch = "epoch-2"), bound.copy(projectId = "project-2"), bound.copy(threadId = "thread-2"),
            bound.copy(request = JsonObject(bound.request + ("turnId" to JsonPrimitive("other-turn")))),
            bound.copy(request = JsonObject(bound.request + ("itemId" to JsonPrimitive("other-item")))),
        )
        changed.forEach { assertFalse(NativeInteractionForms.validate(it, approval("accept"))) }
    }

    @Test fun missingOrTruncatedLatestProofRemovesPreviouslyAvailableAcceptance() {
        val pending = NativeInteractionForms.parse(fileEnvelope())
        val store = FileChangeApprovalContexts()
        store.snapshot(fileScope, fileHistory())
        val bound = NativeInteractionForms.bindFileChangeContext(pending, requireNotNull(store.forInteraction(pending)))
        assertTrue(NativeInteractionForms.validate(bound, approval("accept")))
        store.snapshot(fileScope, fileHistory(truncated = true))
        assertNull(store.forInteraction(pending))
        val withoutProof = NativeInteractionForms.bindFileChangeContext(bound, store.forInteraction(pending))
        assertFalse(NativeInteractionForms.validate(withoutProof, approval("accept")))
        assertEquals(listOf("decline", "cancel"), withoutProof.decisions)
        store.snapshot(fileScope, fileHistory())
        store.clear()
        assertNull(store.forInteraction(pending))
    }

    @Test fun exactPatchProofCannotAuthorizeUnstableGrantRootScope() {
        val envelope = fileEnvelope()
        val request = envelope.getValue("request").jsonObject
        val context = verifiedFileContext()
        for (grantRoot in listOf(JsonPrimitive("/project"), JsonPrimitive("/"), JsonPrimitive(""))) {
            val value = NativeInteractionForms.parse(JsonObject(envelope + ("request" to JsonObject(request + ("grantRoot" to grantRoot)))), context)
            assertFalse("A complete patch does not establish session-wide grant semantics", NativeInteractionForms.validate(value, approval("accept")))
            assertFalse("accept" in value.decisions)
        }
        val explicitNull = NativeInteractionForms.parse(JsonObject(envelope + ("request" to JsonObject(request + ("grantRoot" to JsonNull)))), context)
        assertTrue(NativeInteractionForms.validate(explicitNull, approval("accept")))
    }

    @Test fun uiConversionDoesNotCoerceInvalidNumbersOrLoseBooleans() {
        val number = ElicitationFieldUi("n", "N", type = "number")
        assertNull(NativeInteractionForms.fieldValue(number, "invalid"))
        assertNull(NativeInteractionForms.fieldValue(number, "\"3\""))
        assertNull(NativeInteractionForms.fieldValue(number, "true"))
        assertNull(NativeInteractionForms.fieldValue(number, "1e999"))
        assertEquals(JsonPrimitive(-2.5), NativeInteractionForms.fieldValue(number, "-2.5"))
        assertEquals(JsonPrimitive(false), NativeInteractionForms.fieldValue(ElicitationFieldUi("b", "B", type = "boolean"), "", checked = false))
    }
}
