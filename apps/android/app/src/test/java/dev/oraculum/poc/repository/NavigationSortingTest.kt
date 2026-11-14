package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.NavigationSort
import dev.oraculum.poc.ui.ProjectOption
import dev.oraculum.poc.ui.ThreadOption
import java.util.Locale
import org.junit.Assert.*
import org.junit.Test

class NavigationSortingTest {
    @Test fun defaultsUseProjectNameAndNewestThreadCreation() {
        val projects = listOf(project("b", "Task10"), project("a", "Task2"))
        val threads = listOf(thread("old", "A", created = 10), thread("new", "Z", created = 20))

        assertEquals(listOf("a", "b"), sortedProjects(projects).map { it.id })
        assertEquals(listOf("new", "old"), sortedThreads(threads).map { it.id })
    }

    @Test fun datesAreDescendingWithNullLastAndNaturalNameThenOpaqueIdTies() {
        val values = listOf(
            thread("null-z", "Task10"),
            thread("same-z", "Task2", created = 100, updated = 300),
            thread("old", "A", created = 10, updated = 400),
            thread("same-a", "task2", created = 100, updated = 300),
            thread("same-10", "Task10", created = 100, updated = 300),
            thread("new", "Z", created = 200, updated = 100),
            thread("null-a", "Task2"),
        )

        assertEquals(listOf("new", "same-a", "same-z", "same-10", "old", "null-a", "null-z"),
            sortedThreads(values, NavigationSort.CreatedNewest).map { it.id })
        assertEquals(listOf("old", "same-a", "same-z", "same-10", "new", "null-a", "null-z"),
            sortedThreads(values, NavigationSort.UpdatedNewest).map { it.id })
        assertEquals(listOf("new", "same-a", "same-z", "same-10", "old", "null-a", "null-z"),
            sortedProjects(values.map { project(it.id, it.label, it.createdAt, it.updatedAt) },
                NavigationSort.CreatedNewest).map { it.id })
    }

    @Test fun chineseOrderingUsesFixedChineseCollationInsteadOfTheDeviceLocale() {
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.US)
            val values = listOf(project("shanghai", "上海"), project("beijing", "北京"), project("alpha", "阿尔法"))

            assertEquals(listOf("alpha", "beijing", "shanghai"),
                sortedProjects(values, NavigationSort.NameAscending).map { it.id })
        } finally {
            Locale.setDefault(previous)
        }
    }

    @Test fun caseAccentsAndCompatibilityCharactersUseTheSamePrimaryNameKey() {
        val values = listOf(
            project("c", "álpha"),
            project("b", "ALPHA"),
            project("a", "Alpha"),
            project("z", "Ｔａｓｋ２"),
            project("y", "Task2"),
        )

        assertEquals(listOf("a", "b", "c", "y", "z"),
            sortedProjects(values, NavigationSort.NameAscending).map { it.id })
        assertEquals(listOf("y", "z", "a", "b", "c"),
            sortedProjects(values, NavigationSort.NameDescending).map { it.id })
    }

    @Test fun digitRunsCompareNaturallyWithoutOverflowAndEqualNumbersPreferFewerZeros() {
        val longNine = "9".repeat(80)
        val longerPower = "1" + "0".repeat(80)
        val values = listOf(
            thread("huge-larger", "Task$longerPower"),
            thread("ten", "Task10"),
            thread("zero-zero-two", "Task002"),
            thread("huge-smaller", "Task$longNine"),
            thread("two", "Task2"),
            thread("zero-two", "Task02"),
            thread("one", "Task1"),
        )

        assertEquals(listOf("one", "two", "zero-two", "zero-zero-two", "ten", "huge-smaller", "huge-larger"),
            sortedThreads(values, NavigationSort.NameAscending).map { it.id })
        assertEquals(listOf("huge-larger", "huge-smaller", "ten", "zero-zero-two", "zero-two", "two", "one"),
            sortedThreads(values, NavigationSort.NameDescending).map { it.id })
    }

    @Test fun descendingNamesReverseOnlyNameDirectionAndKeepIdTiesAscending() {
        val values = listOf(
            thread("b", "task2"), thread("a", "Task2"),
            thread("d", "Task10"), thread("c", "TASK10"),
        )

        assertEquals(listOf("c", "d", "a", "b"),
            sortedThreads(values, NavigationSort.NameDescending).map { it.id })
    }

    @Test fun everyModeIsDeterministicForPermutedInputAndPreservesMetadata() {
        val original = listOf(
            ThreadOption("b", "Task2", "source-b", archived = true, createdAt = 20, updatedAt = null),
            ThreadOption("a", "task2", "source-a", archived = false, createdAt = 20, updatedAt = 300),
            ThreadOption("c", "Task10", "source-c", archived = true, createdAt = null, updatedAt = 100),
            ThreadOption("d", "北京", "source-d", archived = false, createdAt = 10, updatedAt = 300),
        )
        val mutableInput = original.toMutableList()
        val permutations = listOf(original, original.reversed()) +
            original.indices.map { offset -> original.drop(offset) + original.take(offset) }
        NavigationSort.values().forEach { sort ->
            val expected = sortedThreads(original, sort).map { it.id }
            permutations.forEach { input -> assertEquals(expected, sortedThreads(input, sort).map { it.id }) }
            val sorted = sortedThreads(mutableInput, sort)
            sorted.forEach { value -> assertSame(original.first { it.id == value.id }, value) }
            assertEquals(original, mutableInput)

            val projects = original.map { project(it.id, it.label, it.createdAt, it.updatedAt) }
            val expectedProjects = sortedProjects(projects, sort).map { it.id }
            assertEquals(expectedProjects, sortedProjects(projects.reversed(), sort).map { it.id })
            sortedProjects(projects, sort).forEach { value ->
                assertSame(projects.first { it.id == value.id }, value)
            }
        }
    }

    private fun project(id: String, label: String, created: Long? = null, updated: Long? = null) =
        ProjectOption(id, label, "source-$id", createdAt = created, updatedAt = updated)

    private fun thread(id: String, label: String, created: Long? = null, updated: Long? = null) =
        ThreadOption(id, label, "source-$id", createdAt = created, updatedAt = updated)
}
