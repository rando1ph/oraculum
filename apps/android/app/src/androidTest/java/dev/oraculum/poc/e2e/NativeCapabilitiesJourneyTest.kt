package dev.oraculum.poc.e2e

import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.PocViewModel
import dev.oraculum.poc.gateway.CredentialVault
import dev.oraculum.poc.gateway.GatewayEndpoint
import dev.oraculum.poc.storage.ClientPreferences
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** One-shot real coordinator acceptance; only a newly created dedicated TEST thread receives writes. */
class NativeCapabilitiesJourneyTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Test fun ownedEmptyThreadRejectsArchiveAndNativeReads() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit native capability acceptance opt-in required",
            args.getString("oraculumNativeCapabilitiesE2e") == "true")
        assertEquals("Only the explicitly dedicated TEST project is eligible", "TEST",
            args.getString("oraculumTestProject") ?: "TEST")
        val preferences = ClientPreferences(context)
        val before = runBlocking { preferences.snapshot() }
        val scope = checkNotNull(before.scopeKey)
        val endpoint = GatewayEndpoint.parse(before.endpoint)
        val vault = CredentialVault(context)
        val identity = checkNotNull(vault.load(endpoint))
        assertTrue("Never pair in this test", identity.identity.paired)
        val drafts = draftContents()
        val report = JSONObject().put("passed", false).put("modelInferenceSends", 0)
        var stage = "preflight"
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                lateinit var model: PocViewModel
                scenario.onActivity { model = it.model }
                await("Saved paired connection ready") { model.state.value.let { it.online && it.paired && !it.busy } }
                clean(model)
                assertFalse("Existing active Turn belongs to user", model.state.value.canStop)
                assertTrue("Pending approvals belong to user", model.state.value.interactions.none { it.status == "pending" })
                val candidates = model.state.value.projects.filter { it.label == "TEST" }
                assumeTrue("A single existing dedicated TEST project is required; never use the user's current project by default", candidates.size == 1)
                val project = candidates.single()
                action { model.selectProject(project.id) }
                action { model.refreshNativeDefaults() }
                action { model.refreshAccount() }
                clean(model)
                assertNotNull("Native project defaults decoded", model.state.value.nativeDefaults)
                assertNotNull("Native quota decoded", model.state.value.accountRateLimits)
                assertNotNull("Native cumulative usage decoded", model.state.value.accountUsage)
                assertNull(model.state.value.accountError)
                assertEquals("native", model.state.value.permissionPreset)
                assertNull(model.state.value.selectedModel)
                assertNull(model.state.value.selectedEffort)
                report.put("nativeReadsPassed", true)
                val guard = File(context.noBackupFilesDir, "native-capabilities-lifecycle-v1.json")
                assertTrue("Prior invocation may have executed; inspect original receipts, never replay", guard.createNewFile())
                FileOutputStream(guard).use {
                    it.write(JSONObject().put("projectId", project.id).put("createdAt", System.currentTimeMillis()).toString().toByteArray())
                    it.fd.sync()
                }
                stage = "create"
                assertTrue(model.state.value.canCreateThread)
                action { model.createThread() }
                clean(model)
                val owned = checkNotNull(model.state.value.selectedThreadId)
                File(context.noBackupFilesDir, "native-capabilities-owned-v1.json").writeText(
                    JSONObject().put("projectId", project.id).put("threadId", owned).toString())
                val name = "Android native capability check ${System.currentTimeMillis()}"
                stage = "rename"
                action { model.renameThread(owned, name) }
                clean(model)
                assertTrue(model.state.value.threads.any { it.id == owned && it.label == name })
                report.put("renamePassed", true)
                // Empty native sessions are not yet part of the lifecycle inventory.
                stage = "empty-archive-rejected"
                action { model.archiveThread(owned) }
                val refusal = checkNotNull(model.state.value.error)
                assertTrue("Unmaterialized history must fail closed",
                    refusal.contains("原生历史尚未就绪") || refusal.contains("THREAD_LIFECYCLE_CHANGED"))
                assertEquals(owned, model.state.value.selectedThreadId)
                assertTrue(model.state.value.unresolvedOperations.isEmpty())
                report.put("unmaterializedArchiveRejected", true)
                action { model.refresh() }
                clean(model)
                stage = "delete-owned"
                action { model.deleteThread(owned) }
                clean(model)
                assertNull(model.state.value.selectedThreadId)
                assertFalse(model.state.value.threads.any { it.id == owned })
                report.put("deletePassed", true)
                assertTrue("Original drafts retained", drafts.all { (key, value) -> draftContents()[key] == value })
                instrumentation.runOnMainSync { model.disconnect() }
                report.put("passed", true)
                stage = "passed"
            }
        } finally {
            runBlocking { preferences.saveSelection(scope, before.projectId, before.threadId) }
            val after = runBlocking { preferences.snapshot() }
            val saved = vault.load(endpoint)
            val identityPreserved = saved?.identity == identity.identity && saved.secret == identity.secret
            report.put("preferencesUnchanged", after == before).put("identityUnchanged", identityPreserved).put("stage", stage)
            instrumentation.sendStatus(0, Bundle().apply { putString("nativeCapabilitiesJourney", report.toString()) })
            assertEquals("Original preferences restored", before, after)
            assertTrue("Original paired identity preserved", identityPreserved)
        }
    }

    /**
     * Separate subject and opt-in from the original empty-thread diagnostic. One harmless native
     * Turn materializes history before lifecycle operations. Retained v1/v2 subjects are never targets.
     */
    @Test fun ownedMaterializedThreadLifecycle() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit materialized native acceptance opt-in required",
            args.getString("oraculumMaterializedNativeE2e") == "true")
        assertEquals("TEST", args.getString("oraculumTestProject") ?: "TEST")
        val preferences = ClientPreferences(context)
        val before = runBlocking { preferences.snapshot() }
        val scope = checkNotNull(before.scopeKey)
        val endpoint = GatewayEndpoint.parse(before.endpoint)
        val vault = CredentialVault(context)
        val identity = checkNotNull(vault.load(endpoint))
        assertTrue(identity.identity.paired)
        val drafts = draftContents()
        val report = JSONObject().put("passed", false).put("modelInferenceSends", 0)
        var stage = "preflight"
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                lateinit var model: PocViewModel
                scenario.onActivity { model = it.model }
                await("Saved paired connection ready") { model.state.value.let { it.online && it.paired && !it.busy } }
                clean(model)
                assertFalse("Do not disturb an existing active Turn", model.state.value.canStop)
                assertTrue(model.state.value.interactions.none { it.status == "pending" })
                val projects = model.state.value.projects.filter { it.label == "TEST" }
                assumeTrue("Only an existing dedicated TEST project may be used", projects.size == 1)
                val project = projects.single()
                action { model.selectProject(project.id) }
                clean(model)
                val advertised = model.state.value.models.firstOrNull { it.id == "gpt-6.1-sol" && "low" in it.efforts }
                assumeTrue("Fast advertised controlled-test model required before writes", advertised != null)
                val selected = checkNotNull(advertised)
                instrumentation.runOnMainSync {
                    model.selectModel(selected.id); model.selectEffort("low"); model.selectPermission("read-only", false)
                }
                val guard = File(context.noBackupFilesDir, "native-capabilities-materialized-v3.json")
                assertTrue("Prior v3 intent may have executed; inspect receipts instead of replaying", guard.createNewFile())
                FileOutputStream(guard).use {
                    it.write(JSONObject().put("ownerProjectId", project.id).put("purpose", "one-owned-materialized-lifecycle")
                        .put("createdAt", System.currentTimeMillis()).toString().toByteArray()); it.fd.sync()
                }
                stage = "create-owned"
                action { model.createThread() }
                clean(model)
                val owned = checkNotNull(model.state.value.selectedThreadId)
                val checkpoint = File(context.noBackupFilesDir, "native-capabilities-owned-v3.json")
                assertTrue("Ownership checkpoint must be new", checkpoint.createNewFile())
                FileOutputStream(checkpoint).use {
                    it.write(JSONObject().put("projectId", project.id).put("threadId", owned).toString().toByteArray()); it.fd.sync()
                }
                stage = "materialize-one-read-only-turn"
                assertTrue("Never claim user attachments", model.files.state.value.attachments.isEmpty())
                instrumentation.runOnMainSync {
                    model.selectModel(selected.id); model.selectEffort("low"); model.selectPermission("read-only", false)
                    model.draftChange("Reply exactly ANDROID_NATIVE_LIFECYCLE_OK. Do not use tools, read files, or modify anything.")
                }
                assertEquals(selected.id, model.state.value.selectedModel)
                assertEquals("low", model.state.value.selectedEffort)
                assertEquals("read-only", model.state.value.permissionPreset)
                // canSend includes a nonblank draft; prepare it before waiting for write readiness.
                await("Prepared owned draft ready for one explicit send") { model.state.value.canSend && !model.state.value.busy }
                clean(model)
                action { model.send() }
                report.put("modelInferenceSends", 1)
                clean(model)
                await("Exact native reply and idle snapshot read back") {
                    model.state.value.let { state -> !state.busy && !state.canStop && state.canManageThread &&
                        state.actualModel == selected.id && state.actualEffort == "low" &&
                        state.messages.any { it.role == "assistant" && it.text.contains("ANDROID_NATIVE_LIFECYCLE_OK") && it.turn?.status == "completed" } }
                }
                clean(model)
                val permission = model.state.value.actualPermissionPreset
                permission?.let { assertTrue("Returned permission must match", it == "read-only") }
                report.put("nativeTurnCompleted", true).put("actualModelAndEffortReadBack", true)
                    .put("permissionReadbackAvailable", permission != null)
                stage = "rename"
                val name = "Android materialized capability check ${System.currentTimeMillis()}"
                action { model.renameThread(owned, name) }
                clean(model)
                assertTrue(model.state.value.threads.any { it.id == owned && it.label == name })
                report.put("renamePassed", true)
                stage = "archive"
                action { model.archiveThread(owned) }
                clean(model)
                assertNull(model.state.value.selectedThreadId)
                assertFalse(model.state.value.threads.any { it.id == owned })
                action { model.showArchivedThreads(true) }
                clean(model)
                assertTrue(model.state.value.threads.any { it.id == owned && it.archived })
                report.put("archivePassed", true)
                stage = "restore"
                action { model.unarchiveThread(owned) }
                clean(model)
                assertEquals(owned, model.state.value.selectedThreadId)
                assertFalse(model.state.value.showArchivedThreads)
                report.put("restorePassed", true)
                stage = "delete-owned"
                action { model.deleteThread(owned) }
                clean(model)
                assertNull(model.state.value.selectedThreadId)
                assertFalse(model.state.value.threads.any { it.id == owned })
                report.put("deletePassed", true)
                assertTrue("Original drafts retained", drafts.all { (key, value) -> draftContents()[key] == value })
                instrumentation.runOnMainSync { model.disconnect() }
                report.put("passed", true)
                stage = "passed"
            }
        } finally {
            runBlocking { preferences.saveSelection(scope, before.projectId, before.threadId) }
            val after = runBlocking { preferences.snapshot() }
            val saved = vault.load(endpoint)
            val identityPreserved = saved?.identity == identity.identity && saved.secret == identity.secret
            report.put("preferencesUnchanged", after == before).put("identityUnchanged", identityPreserved).put("stage", stage)
            instrumentation.sendStatus(0, Bundle().apply { putString("materializedNativeJourney", report.toString()) })
            assertEquals(before, after)
            assertTrue("Original paired identity preserved", identityPreserved)
        }
    }

    /** Reads the original v3 subject; continuation is separately authorized and never sends a Turn. */
    @Test fun diagnoseAndCompleteOwnedV3() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit owned v3 inspection required", args.getString("oraculumInspectOwnedV3") == "true")
        val finalize = args.getString("oraculumFinalizeOwnedV3") == "true"
        val owner = JSONObject(File(context.noBackupFilesDir, "native-capabilities-owned-v3.json").readText())
        val intent = JSONObject(File(context.noBackupFilesDir, "native-capabilities-materialized-v3.json").readText())
        val project = owner.getString("projectId")
        val owned = owner.getString("threadId")
        assertTrue("Original durable ownership must match", project == intent.getString("ownerProjectId"))
        val preferences = ClientPreferences(context)
        val before = runBlocking { preferences.snapshot() }
        val scope = checkNotNull(before.scopeKey)
        val endpoint = GatewayEndpoint.parse(before.endpoint)
        val vault = CredentialVault(context)
        val identity = checkNotNull(vault.load(endpoint))
        val drafts = draftContents()
        val report = JSONObject().put("finalizationRequested", finalize).put("finalized", false).put("modelInferenceSends", 0)
        var stage = "read-owned-v3"
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                lateinit var model: PocViewModel
                scenario.onActivity { model = it.model }
                await("Saved paired connection ready") { model.state.value.let { it.online && it.paired && !it.busy } }
                assertTrue("Ownership belongs to the dedicated TEST project",
                    model.state.value.projects.any { it.id == project && it.label == "TEST" })
                action { model.selectProject(project) }
                var pages = 0
                while (model.state.value.threads.none { it.id == owned } && model.state.value.canLoadMoreThreads && pages++ < 20)
                    action { model.loadMoreThreads() }
                assertTrue("Original owned v3 target must still be in the active list", model.state.value.threads.any { it.id == owned && !it.archived })
                action { model.selectThread(owned) }
                val state = model.state.value
                val marker = "ANDROID_NATIVE_LIFECYCLE_OK"
                val completed = state.messages.any { it.role == "assistant" && it.text.contains(marker) && it.turn?.status == "completed" }
                report.put("online", state.online).put("busy", state.busy).put("canManage", state.canManageThread)
                    .put("canResume", state.canResume).put("canStop", state.canStop)
                    .put("hasMarker", state.messages.any { it.role == "assistant" && it.text.contains(marker) })
                    .put("assistantCompletedCount", state.messages.count { it.role == "assistant" && it.turn?.status == "completed" })
                    .put("actualModelPresent", state.actualModel != null).put("actualModelMatches", state.actualModel == "gpt-6.1-sol")
                    .put("effortPresent", state.actualEffort != null).put("effortMatches", state.actualEffort == "low")
                    .put("permissionPresent", state.actualPermissionPreset != null).put("permissionMatches", state.actualPermissionPreset == "read-only")
                    .put("unknown", state.unknownWarning != null || state.unresolvedOperations.isNotEmpty())
                    .put("markerCompleted", completed).put("diagnosisComplete", true)
                instrumentation.sendStatus(0, Bundle().apply { putString("ownedV3Diagnostic", report.toString()) })
                if (finalize) {
                    assertTrue("Owned native marker must be completed and idle", completed && state.canManageThread && !state.canStop && !state.busy)
                    clean(model)
                    state.actualModel?.let { assertTrue("Returned native model must match", it == "gpt-6.1-sol") }
                    state.actualEffort?.let { assertTrue("Returned effort must match", it == "low") }
                    state.actualPermissionPreset?.let { assertTrue("Returned permission must match", it == "read-only") }
                    assertTrue("Selection remains the original owned v3 target", model.state.value.selectedThreadId == owned)
                    val guard = File(context.noBackupFilesDir, "native-capabilities-finalize-v3.json")
                    assertTrue("Finalization may already have executed; query its original receipts", guard.createNewFile())
                    FileOutputStream(guard).use {
                        it.write(JSONObject().put("projectId", project).put("threadId", owned)
                            .put("createdAt", System.currentTimeMillis()).toString().toByteArray()); it.fd.sync()
                    }
                    stage = "archive-owned-v3"
                    action { model.archiveThread(owned) }
                    clean(model)
                    assertFalse(model.state.value.threads.any { it.id == owned })
                    action { model.showArchivedThreads(true) }
                    clean(model)
                    assertTrue(model.state.value.threads.any { it.id == owned && it.archived })
                    report.put("archivePassed", true)
                    stage = "restore-owned-v3"
                    action { model.unarchiveThread(owned) }
                    clean(model)
                    assertTrue("Restored selection matches the owned subject", owned == model.state.value.selectedThreadId)
                    report.put("restorePassed", true)
                    stage = "delete-owned-v3"
                    action { model.deleteThread(owned) }
                    clean(model)
                    assertNull(model.state.value.selectedThreadId)
                    assertFalse(model.state.value.threads.any { it.id == owned })
                    report.put("deletePassed", true).put("finalized", true)
                }
                assertTrue("Original draft contents preserved", drafts.all { (key, value) -> draftContents()[key] == value })
                instrumentation.runOnMainSync { model.disconnect() }
                stage = "passed"
            }
        } finally {
            runBlocking { preferences.saveSelection(scope, before.projectId, before.threadId) }
            val after = runBlocking { preferences.snapshot() }
            val saved = vault.load(endpoint)
            val identityPreserved = saved?.identity == identity.identity && saved.secret == identity.secret
            report.put("preferencesUnchanged", before == after).put("identityUnchanged", identityPreserved).put("stage", stage)
            instrumentation.sendStatus(0, Bundle().apply { putString("ownedV3Diagnostic", report.toString()) })
            assertTrue("Original preferences preserved", before == after)
            assertTrue("Original paired identity preserved", identityPreserved)
        }
    }

    private fun action(start: () -> Job) {
        var job: Job? = null
        instrumentation.runOnMainSync { job = start() }
        runBlocking { withTimeout(90_000) { checkNotNull(job).join() } }
    }
    private fun clean(model: PocViewModel) {
        assertNull("Coordinator error", model.state.value.error)
        assertTrue("Unknown operations must not be bypassed", model.state.value.unresolvedOperations.isEmpty())
        assertNull(model.state.value.unknownWarning)
    }
    private fun await(description: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 90_000
        while (System.currentTimeMillis() < deadline) { if (condition()) return; Thread.sleep(50) }
        fail(description)
    }
    private fun draftContents(): Map<String, String> =
        SQLiteDatabase.openDatabase(context.getDatabasePath("oraculum-v2-state.db").path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT scopeKey, projectId, threadId, text FROM drafts", null).use { cursor ->
                buildMap { while (cursor.moveToNext()) put((0..2).joinToString("|") { cursor.getString(it).orEmpty() }, cursor.getString(3).orEmpty()) }
            }
        }
}
