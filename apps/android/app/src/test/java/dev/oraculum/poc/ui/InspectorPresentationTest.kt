package dev.oraculum.poc.ui

import org.junit.Assert.*
import org.junit.Test

class InspectorPresentationTest {
    @Test fun ratiosRequireKnownCompatibleCounts() {
        assertNull(usageRatio(null, 100))
        assertNull(usageRatio(0, null))
        assertNull(usageRatio(0, 0))
        assertNull(usageRatio(-1, 10))
        assertNull(usageRatio(101, 100))
        assertEquals(.25f, usageRatio(25, 100)!!, .0001f)
        assertEquals(0f, usageRatio(0, 100)!!, .0001f)
        assertEquals(1f, usageRatio(Long.MAX_VALUE, Long.MAX_VALUE)!!, .0001f)
    }

    @Test fun extensionProjectionDoesNotLeakRawProtocolFields() {
        val visible = extensionEntryDescription("description: \"Project tools\"\nenabled: true\ncallable: false\ntoolCount: 12\nresourceCount: 0\nstatus: \"ready / notLoggedIn\"\nsource: \"private-provider-id\"")
        assertTrue(visible.contains("Project tools"))
        assertTrue(visible.contains("工具 12 · 资源 0"))
        assertTrue(visible.contains("已启用 · 暂不可调用"))
        assertTrue(visible.contains("需要登录"))
        assertFalse(visible.contains("enabled"))
        assertFalse(visible.contains("true"))
        assertFalse(visible.contains("private-provider-id"))
        assertFalse(extensionUnavailableReason("plugins", "STABILITY_UNVERIFIED").contains("STABILITY"))
    }

    @Test fun malformedOrUnrecognizedExtensionFieldsDoNotBecomeDisplayText() {
        assertEquals("", extensionEntryDescription("enabled: nonsense\nresourceCount: -5\nstatus: \"new-internal-state\"\nsecret: \"never shown\""))
    }
}
