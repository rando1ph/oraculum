package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.ProjectOption
import dev.oraculum.poc.ui.ThreadOption
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NavigationListsTest {
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun ids(data: JsonObject, key: String = "threads") =
        data.getValue(key).jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }

    @Test fun projectsAlwaysUseAscendingCaseInsensitiveNaturalNames() {
        val values = listOf(ProjectOption("ten", "Task10"), ProjectOption("two", "task2"),
            ProjectOption("upper", "Alpha"), ProjectOption("lower", "alpha"))
        assertEquals(listOf("lower", "upper", "two", "ten"), sortedProjects(values).map { it.id })
        assertEquals(listOf("lower", "upper", "two", "ten"), sortedProjects(values.reversed()).map { it.id })
        assertEquals(listOf("ten", "two", "upper", "lower"), values.map { it.id })
    }

    @Test fun chineseProjectNamesUsePinyinRatherThanCodePointOrder() {
        val values = listOf(ProjectOption("shanghai", "上海"), ProjectOption("beijing", "北京"), ProjectOption("alpha", "阿尔法"))
        assertEquals(listOf("alpha", "beijing", "shanghai"), sortedProjects(values).map { it.id })
    }

    @Test fun threadPagesKeepTheirReturnedOrderAndOnlySuppressRepeatedIds() {
        val first = listOf(ThreadOption("z", "Zulu"), ThreadOption("a", "Alpha"))
        val next = listOf(ThreadOption("m", "Middle"), ThreadOption("a", "Changed"), ThreadOption("b", "Beta"))
        val result = appendThreadPage(first, next)
        assertEquals(listOf("z", "a", "m", "b"), result.map { it.id })
        assertSame(first[1], result[1])
        assertEquals(listOf("z", "a"), first.map { it.id })
    }

    @Test fun unlistedNewThreadDoesNotJumpAheadOfLaterGatewayPages() {
        val first = listOf(ThreadOption("z", "Zulu"), ThreadOption("fresh", "新会话"))
        val next = listOf(ThreadOption("a", "Alpha"), ThreadOption("m", "Middle"))
        assertEquals(listOf("z", "a", "m", "fresh"), appendThreadPage(first, next, setOf("fresh")).map { it.id })
        val published = next + ThreadOption("fresh", "Now listed") + ThreadOption("b", "Beta")
        assertEquals(listOf("z", "a", "m", "fresh", "b"), appendThreadPage(first, published, setOf("fresh")).map { it.id })
    }

    @Test fun mergedRawWindowRetainsTheGatewayOrderAndLastCursor() {
        val first = obj("""{"threads":[{"id":"z","createdAt":1},{"id":"a","createdAt":999}],"nextCursor":"p2","projectId":"p"}""")
        val next = obj("""{"threads":[{"id":"m"},{"id":"z"},{"id":"b"}],"nextCursor":"p3","limited":true}""")
        val result = mergeThreadPages(first, next)
        assertEquals(listOf("z", "a", "m", "b"), ids(result))
        assertEquals(JsonPrimitive("p3"), result["nextCursor"])
        assertEquals(JsonPrimitive("p"), result["projectId"])
        assertEquals(JsonPrimitive(true), result["limited"])
    }

    @Test fun removingRegistrationPreservesOtherProjectsRootsAndHistoryData() {
        val data = obj("""{"projects":[{"id":"target","canonicalPath":"/fixture/target"},{"id":"keep","canonicalPath":"/fixture/keep"}],"roots":[{"id":"root"}],"history":{"items":["retained"]}}""")
        val result = withoutRegisteredProject(data, "target")
        assertEquals(listOf("keep"), ids(result, "projects"))
        assertEquals(data["roots"], result["roots"])
        assertEquals(data["history"], result["history"])
        assertEquals(listOf("target", "keep"), ids(data, "projects"))
        assertEquals(result, withoutRegisteredProject(result, "target"))
        assertEquals(data, withoutRegisteredProject(data, "absent"))
    }
}
