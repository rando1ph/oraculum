package dev.oraculum.poc.e2e

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.ParcelFileDescriptor
import android.os.Process
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.files.FilesUiState
import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Real DocumentsUI -> temporary content URI -> real Gateway attachment/file contract. */
class Phase3FilesJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val model get() = compose.activity.model
    private val files get() = model.files.state.value
    private val directory get() = File(context.filesDir, "phase3-evidence").apply { mkdirs() }

    private fun connected() {
        assumeTrue("Private Phase 3 fixture required", File(context.noBackupFilesDir, "phase3-e2e.json").isFile)
        val checkpoint = JSONObject(File(directory, "checkpoint.json").readText())
        until("Dedicated Phase 3 files scope ready") {
            model.state.value.online && !model.state.value.busy && it.readable && it.writable && !it.busy &&
                it.threadId == checkpoint.getString("threadId") && it.projectId == checkpoint.getString("projectId")
        }
    }

    private fun until(description: String, timeout: Long = 120_000, check: (FilesUiState) -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (check(files)) return
            Thread.sleep(80)
        }
        fail("$description; files=${files.message}; connection=${model.state.value.connectionLabel}; error=${model.state.value.error}")
    }

    private fun screenshot(name: String, waitForCompose: Boolean = true) {
        if (waitForCompose) compose.waitForIdle()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun record(name: String, extra: JSONObject = JSONObject()) {
        File(directory, "$name.json").writeText(extra.put("passed", true).put("threadId", files.threadId)
            .put("attachmentCount", files.attachments.size).put("unknown", files.hasUnknown).toString(2))
    }

    @Test fun safCancellationThenRealDocumentAndImageUpload() {
        connected()
        val before = files.attachments.map { it.id }
        compose.onNodeWithTag("files_pick").performClick()
        waitForDocumentsUi()
        instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        until("Picker cancellation preserves attachments") { !it.busy && it.attachments.map { attachment -> attachment.id } == before }
        chooseDocument("phase3-note.txt")
        until("Actual SAF document uploaded once") { !it.busy && it.attachments.any { a -> a.name == "phase3-note.txt" && a.status == "ready" } }
        chooseDocument("phase3-image.png")
        until("Actual SAF image uploaded once") { !it.busy && it.attachments.any { a -> a.name == "phase3-image.png" && a.status == "ready" && a.previewFile?.isFile == true } }
        assertEquals(1, files.attachments.count { it.name == "phase3-note.txt" })
        assertEquals(1, files.attachments.count { it.name == "phase3-image.png" })
        screenshot("11-saf-uploaded-attachments")
        record("saf-cancel-document-image", JSONObject().put("usedSystemPicker", true))
    }

    @Test fun safOversizeAndUnreadableUriDoNotUpload() {
        connected()
        val before = files.attachments.map { it.id }
        chooseDocument("phase3-large.txt")
        until("Oversize SAF file rejected") { !it.busy && it.message != null }
        assertEquals(before, files.attachments.map { it.id })
        assertFalse(files.hasUnknown)
        chooseDocument("phase3-unavailable.txt")
        until("Unavailable granted URI rejected before write") { !it.busy && it.message != null }
        assertEquals(before, files.attachments.map { it.id })
        assertFalse(files.hasUnknown)
        screenshot("12-saf-unavailable-uri")
        record("saf-size-uri-rejected")
    }

    @Test fun explicitTurnClaimsReadyAttachments() {
        connected()
        assertTrue(files.attachments.any { it.name == "phase3-note.txt" && it.status == "ready" })
        assertTrue(files.attachments.any { it.name == "phase3-image.png" && it.status == "ready" })
        val previousMessageIds = model.state.value.messages.map { it.id }.toSet()
        compose.onNodeWithTag("draft").performTextReplacement("Read the attached plain text document and report its exact first line. Briefly describe the attached small image. Finish with P3_ATTACHMENTS_CLAIMED. Do not modify any files.")
        Espresso.closeSoftKeyboard()
        compose.onNodeWithTag("send").assertIsEnabled().performClick()
        until("Real native turn received claimed attachments", 240_000) {
            !model.state.value.canStop && !model.state.value.busy && model.state.value.error == null &&
                !it.busy && !it.hasUnknown && it.attachments.isEmpty() &&
                model.state.value.messages.any { message -> message.id !in previousMessageIds && message.role == "assistant" &&
                    message.text.contains("P3_ATTACHMENTS_CLAIMED") && message.text.contains("PHASE3_ATTACHMENT_VERIFIED") }
        }
        screenshot("13-native-attachment-response")
        record("native-attachment-claim")
    }

    @Test fun authorizedHostPreviewAndSystemShare() {
        connected()
        openHostDirectory()
        compose.onNodeWithTag("file_phase3-note.md").performScrollTo().performClick()
        until("Authorized Markdown download verified") { !it.busy && it.preview?.name == "phase3-note.md" }
        val preview = checkNotNull(files.preview)
        assertTrue(preview.file.isFile)
        assertEquals(preview.size, preview.file.length())
        assertTrue(preview.file.readText().contains("Phase 3"))
        assertEquals(131L, preview.size)
        val receiverPackage = "dev.oraculum.poc.debug.test"
        assertEquals(receiverPackage, instrumentation.context.packageName)
        shell("run-as $receiverPackage rm -f files/phase3-share-receipt.json")
        val shareStartedAt = System.currentTimeMillis()
        compose.onNodeWithTag("files_preview").performScrollTo()
        screenshot("14-verified-host-preview")
        compose.onNodeWithTag("files_share").performScrollTo().performClick()
        val destinationPackage = waitForStableFocusedWindow("Actual Android share destination") { root ->
            (root.packageName?.toString() in setOf("android", "com.android.intentresolver") && hasResolverContent(root, preview.name)) ||
                (root.packageName?.toString() == receiverPackage && findNode(root, setOf("Return to Oraculum")) != null)
        }
        val chooserObserved = destinationPackage != receiverPackage
        if (chooserObserved) {
            screenshot("14b-system-sharesheet-receiver-choice", waitForCompose = false)
            systemClick(setOf("Phase 3 share receiver"))
        }
        waitForStableFocusedWindow("Actual receiving test application") { root ->
            root.packageName?.toString() == receiverPackage && findNode(root, setOf("Return to Oraculum")) != null
        }
        val receipt = JSONObject(shell("run-as $receiverPackage cat files/phase3-share-receipt.json"))
        assertTrue("Receiver wrote a fresh receipt", receipt.getLong("createdAt") >= shareStartedAt)
        assertEquals(receiverPackage, receipt.getString("receiverPackage"))
        assertNotEquals("Recipient must read across application UIDs", Process.myUid(), receipt.getInt("receiverUid"))
        assertTrue("Receiver verifies the actual shared bytes and read-only grant: ${receipt.optString("failedCheck")}", receipt.getBoolean("verified"))
        assertEquals(131, receipt.getInt("bytes"))
        assertEquals("92ba25eb3cd32527ef0ef220d24ce6f29978ad295459891e1ffd5c0236c6c8b1", receipt.getString("sha256"))
        assertTrue(receipt.getBoolean("contentMatches"))
        assertTrue(receipt.getBoolean("readFlag")); assertTrue(receipt.getBoolean("readGranted"))
        assertFalse(receipt.getBoolean("writeFlag")); assertFalse(receipt.getBoolean("writeGranted"))
        screenshot("14c-verified-share-receiver", waitForCompose = false)
        systemClick(setOf("Return to Oraculum"))
        waitForStableFocusedWindow("Focused application window after receiver returns") { root -> root.packageName?.toString() == context.packageName }
        compose.waitForIdle()
        assertEquals(preview.file, files.preview?.file)
        compose.onNodeWithTag("close-panel").assertIsDisplayed().performClick()
        record("host-preview-system-share", JSONObject().put("verifiedBytes", preview.size).put("mime", preview.mime)
            .put("shareRouting", if (chooserObserved) "resolver_selection" else "direct_receiver")
            .put("systemChooserObserved", chooserObserved).put("explicitReceiverSelection", chooserObserved)
            .put("receiverVerified", true).put("receiverReadOnlyGrant", true)
            .put("sha256", receipt.getString("sha256")))
    }

    /** Run once after corruptNextDownload, and separately after truncateNextDownload. */
    @Test fun damagedDownloadNeverBecomesPreview() {
        connected()
        compose.runOnIdle { model.files.closePreview() }
        openHostDirectory()
        compose.onNodeWithTag("file_phase3-note.md").performScrollTo().performClick()
        until("Damaged download explicitly failed") { !it.busy && it.message != null }
        assertNull(files.preview)
        compose.onNodeWithTag("files_share").assertDoesNotExist()
        screenshot("15-rejected-download")
        Espresso.pressBack()
        record("download-integrity-rejected")
    }

    /** Precondition: dropNextWriteResponse for this thread's attachments endpoint. */
    @Test fun lostUploadAcknowledgementRetainsUnknown() {
        connected()
        assertTrue("Use a settled attachment draft", files.attachments.isEmpty())
        chooseDocument("phase3-note.txt")
        until("Lost upload receipt blocks new attachments") { !it.busy && it.hasUnknown && it.attachments.any { a -> a.status == "unknown" } }
        assertFalse(model.state.value.canSend)
        compose.onNodeWithTag("files_pick").assertIsNotEnabled()
        screenshot("16-upload-unknown")
        record("upload-unknown")
    }

    @Test fun originalUploadReceiptReconcilesWithoutReupload() {
        assumeTrue(File(context.noBackupFilesDir, "phase3-e2e.json").isFile)
        compose.runOnIdle { model.reconnect() }
        until("Transport restored") { model.state.value.online && !model.state.value.busy && it.readable }
        compose.runOnIdle { model.files.reconcile() }
        until("Original upload operation resolves to ready attachment") { !it.busy && !it.hasUnknown && it.attachments.count { a -> a.name == "phase3-note.txt" && a.status == "ready" } == 1 }
        record("upload-original-receipt")
    }

    private fun openHostDirectory() {
        compose.onNodeWithTag("inspector").performClick()
        compose.onNodeWithTag("inspector-files").performScrollTo().performClick()
        compose.onNodeWithTag("files_refresh").performClick()
        until("Authorized project root listed") { !it.busy && it.entries.any { row -> row.name == "artifacts" && row.directory } }
        compose.onNodeWithTag("file_artifacts").performScrollTo().performClick()
        until("Authorized artifacts listed") { !it.busy && it.path == "artifacts" && it.entries.any { row -> row.name == "phase3-note.md" } }
    }

    private fun chooseDocument(name: String) {
        compose.onNodeWithTag("files_pick").performClick()
        waitForDocumentsUi()
        if (!systemHas(name)) {
            systemClick(setOf("Show roots", "Open navigation drawer", "显示根目录", "打开导航抽屉"))
            systemClick(setOf("Phase 3 test files"))
        }
        systemClick(setOf(name))
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == context.packageName) return
            if (systemHas("Open") || systemHas("打开")) {
                systemClick(setOf("Open", "打开")); return
            }
            Thread.sleep(100)
        }
        fail("System picker did not return the selected test document")
    }

    private fun waitForDocumentsUi() {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui") == true) return
            Thread.sleep(100)
        }
        fail("Android system DocumentsUI did not open")
    }

    private fun systemHas(label: String): Boolean = findNode(instrumentation.uiAutomation.rootInActiveWindow, setOf(label)) != null

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private fun systemClick(labels: Set<String>) {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            var node = findNode(instrumentation.uiAutomation.rootInActiveWindow, labels)
            while (node != null) {
                if (node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
                node = node.parent
            }
            Thread.sleep(100)
        }
        fail("System picker control not found: ${labels.joinToString()}")
    }

    private fun findNode(node: AccessibilityNodeInfo?, labels: Set<String>): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.text?.toString() in labels || node.contentDescription?.toString() in labels) return node
        for (index in 0 until node.childCount) findNode(node.getChild(index), labels)?.let { return it }
        return null
    }

    /** Wait for platform focus and actual content, not merely a transient non-app accessibility root. */
    private fun waitForStableFocusedWindow(description: String, matches: (AccessibilityNodeInfo) -> Boolean): String {
        val automation = instrumentation.uiAutomation
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
        val deadline = System.currentTimeMillis() + 15_000
        var previous: String? = null
        var stableSamples = 0
        while (System.currentTimeMillis() < deadline) {
            val root = automation.rootInActiveWindow
            val focused = root != null && automation.windows.any { it.id == root.windowId && it.isFocused }
            val bounds = Rect()
            root?.getBoundsInScreen(bounds)
            val geometry = if (root != null && root.isVisibleToUser && root.childCount > 0 && focused && !bounds.isEmpty && matches(root))
                "${root.packageName}:${root.windowId}:${bounds.flattenToString()}" else null
            stableSamples = if (geometry != null && geometry == previous) stableSamples + 1 else 0
            if (stableSamples >= 4) return checkNotNull(root?.packageName).toString()
            previous = geometry
            Thread.sleep(100)
        }
        fail("$description did not acquire stable platform focus and content")
        throw AssertionError(description)
    }

    private fun hasResolverContent(node: AccessibilityNodeInfo?, filename: String): Boolean {
        if (node == null) return false
        val id = node.viewIdResourceName.orEmpty().substringAfter(":id/")
        if (node.isVisibleToUser && (id.contains("chooser", true) || id.contains("resolver", true) ||
                node.text?.toString() == filename || node.text?.toString() == "分享成果")) return true
        for (index in 0 until node.childCount) if (hasResolverContent(node.getChild(index), filename)) return true
        return false
    }
}
