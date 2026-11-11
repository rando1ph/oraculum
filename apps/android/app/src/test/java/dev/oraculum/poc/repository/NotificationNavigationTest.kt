package dev.oraculum.poc.repository

import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NotificationNavigationTest {
    private fun obj(value: String) = Json.parseToJsonElement(value).jsonObject
    private val projects = obj("""{"projects":[{"id":"project","available":true}]}""")
    private val listed = obj("""{"threads":[{"id":"target"}],"nextCursor":null}""")
    private val snapshot = obj("""{"epoch":"epoch","thread":{"id":"target","projectId":"project"},"history":{"epoch":"epoch","items":[],"truncated":false}}""")

    @Test fun nativeTimeoutBeforeNavigationLeavesPriorConversationSelected() = runBlocking {
        var selection = "prior-thread"
        var draft = "unsent draft"
        try {
            readNotificationTarget("project", "target", { projects }, { listed }, { throw IOException("native timed out") })
            selection = "target"
            draft = "target draft"
            fail("Read failure must not produce a target that can be committed")
        } catch (error: NativeReadFailed) {
            assertEquals(NativeReadStage.SNAPSHOT, error.stage)
            assertTrue(error.cause is IOException)
            assertTrue(error.elapsedMillis >= 0)
        }
        assertEquals("prior-thread", selection)
        assertEquals("unsent draft", draft)
    }

    @Test fun unlistedThreadCannotBeAuthorizedBySuccessfulDirectRead() = runBlocking {
        var snapshotReads = 0
        try {
            readNotificationTarget("project", "target", { projects }, { obj("""{"threads":[],"nextCursor":null}""") }, {
                snapshotReads++; snapshot
            })
            fail("An unlisted target is not eligible")
        } catch (_: NotificationTargetUnavailable) { }
        assertEquals(0, snapshotReads)
    }

    @Test fun boundedPaginationFindsTargetBeforeOneSnapshotRead() = runBlocking {
        val cursors = mutableListOf<String?>()
        var snapshots = 0
        val result = readNotificationTarget("project", "target", { projects }, { cursor ->
            cursors += cursor
            if (cursor == null) obj("""{"threads":[{"id":"other"}],"nextCursor":"page2"}""") else listed
        }, { snapshots++; snapshot })
        assertEquals(listOf(null, "page2"), cursors)
        assertEquals(1, snapshots)
        assertEquals(snapshot, result.snapshot)
        assertEquals("target", result.thread["id"]!!.jsonPrimitive.content)
    }

    @Test fun endlessOrRepeatedCursorsNeverCreateUnboundedNavigationReads() = runBlocking {
        for (repeatCursor in listOf(false, true)) {
            var reads = 0
            try {
                readNotificationTarget("project", "target", { projects }, {
                    reads++
                    buildJsonObject { put("threads", JsonArray(emptyList())); put("nextCursor", if (repeatCursor) "same" else "page$reads") }
                }, { fail("No unlisted snapshot read"); snapshot })
                fail("The target was not in the bounded active list")
            } catch (_: NotificationTargetUnavailable) { }
            assertEquals(if (repeatCursor) 2 else 10, reads)
        }
    }

    @Test fun wrongProjectEpochOrThreadSnapshotCannotCommitNavigation() = runBlocking {
        val invalid = listOf(
            JsonObject(snapshot + ("thread" to obj("""{"id":"other","projectId":"project"}"""))),
            JsonObject(snapshot + ("thread" to obj("""{"id":"target","projectId":"other"}"""))),
            JsonObject(snapshot + ("history" to obj("""{"epoch":"old"}"""))),
            JsonObject(snapshot - "history"),
        )
        for (value in invalid) {
            try { readNotificationTarget("project", "target", { projects }, { listed }, { value }); fail("Mismatched snapshot accepted") }
            catch (_: NotificationTargetUnavailable) { }
        }
    }

    @Test fun failuresIdentifyTheirExactReadStageWithoutChangingTheCause() = runBlocking {
        for (stage in listOf(NativeReadStage.PROJECTS, NativeReadStage.ACTIVE_THREADS, NativeReadStage.SNAPSHOT)) {
            val failure = IOException("private response details")
            try {
                readNotificationTarget("project", "target",
                    { if (stage == NativeReadStage.PROJECTS) throw failure else projects },
                    { if (stage == NativeReadStage.ACTIVE_THREADS) throw failure else listed },
                    { if (stage == NativeReadStage.SNAPSHOT) throw failure else snapshot })
                fail("The selected native read failed")
            } catch (error: NativeReadFailed) {
                assertEquals(stage, error.stage)
                assertSame(failure, error.cause)
            }
        }
    }
}
