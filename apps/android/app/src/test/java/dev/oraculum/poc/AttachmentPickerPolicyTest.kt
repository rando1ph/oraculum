package dev.oraculum.poc

import org.junit.Assert.*
import org.junit.Test

class AttachmentPickerPolicyTest {
    private fun item(mime: String = "application/pdf", value: String = "content://documents/1") =
        AttachmentPickerPolicy.Selection(value, "content", "documents", mime, false)

    @Test fun exactAllowlistAndOpenModesOnly() {
        val types = AttachmentPickerPolicy.mimeTypes.toList()
        assertTrue(AttachmentPickerPolicy.acceptsRequest(types, true, false))
        assertTrue(AttachmentPickerPolicy.acceptsRequest(listOf(types.joinToString(",")), true, false))
        assertFalse(AttachmentPickerPolicy.acceptsRequest(listOf("*/*"), true, false))
        assertFalse(AttachmentPickerPolicy.acceptsRequest(types + "application/zip", true, false))
        assertFalse(AttachmentPickerPolicy.acceptsRequest(types, true, true))
        assertFalse(AttachmentPickerPolicy.acceptsRequest(types, false, false))
    }
    @Test fun singleAndBoundedMultipleWithTemporaryReadGrant() {
        for (mime in AttachmentPickerPolicy.mimeTypes) assertTrue(AttachmentPickerPolicy.acceptsResult(listOf(item(mime)), false, true, true))
        val many = (1..6).map { item(value = "content://documents/$it") }
        assertTrue(AttachmentPickerPolicy.acceptsResult(many, true, true, true))
        assertFalse(AttachmentPickerPolicy.acceptsResult(many, false, true, true))
        assertFalse(AttachmentPickerPolicy.acceptsResult(many + item(value = "content://documents/7"), true, true, true))
        assertFalse(AttachmentPickerPolicy.acceptsResult(listOf(item(), item()), true, true, true))
        assertFalse(AttachmentPickerPolicy.acceptsResult(emptyList(), true, true, true))
        assertFalse(AttachmentPickerPolicy.acceptsResult(listOf(item()), true, false, true))
        assertFalse(AttachmentPickerPolicy.acceptsResult(listOf(item()), true, true, false))
    }
    @Test fun rejectsFileUrisPrivateProvidersAndUnknownTypes() {
        for (bad in listOf(item().copy(scheme = "file"), item().copy(authority = null), item().copy(ownProvider = true),
            item("application/zip"), item().copy(mime = null), item("application/octet-stream"))) {
            assertFalse(AttachmentPickerPolicy.acceptsResult(listOf(bad), true, true, true))
        }
    }
}
