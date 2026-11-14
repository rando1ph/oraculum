package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.NavigationSort
import dev.oraculum.poc.ui.ProjectOption
import dev.oraculum.poc.ui.ThreadOption
import java.text.Collator
import java.text.Normalizer
import java.util.Locale

/** Sort only the loaded navigation items. No local clock or list position stands in for a date. */
fun sortedProjects(items: List<ProjectOption>, sort: NavigationSort = NavigationSort.NameAscending): List<ProjectOption> =
    navigationSorted(items, sort, ProjectOption::id, ProjectOption::label, ProjectOption::createdAt, ProjectOption::updatedAt)

fun sortedThreads(items: List<ThreadOption>, sort: NavigationSort = NavigationSort.CreatedNewest): List<ThreadOption> =
    navigationSorted(items, sort, ThreadOption::id, ThreadOption::label, ThreadOption::createdAt, ThreadOption::updatedAt)

private fun <T> navigationSorted(
    items: List<T>, sort: NavigationSort, id: (T) -> String, label: (T) -> String,
    createdAt: (T) -> Long?, updatedAt: (T) -> Long?,
): List<T> {
    // A comparator owns its Collator: the mutable platform collator is never shared between calls.
    val collator = Collator.getInstance(Locale.SIMPLIFIED_CHINESE).apply {
        strength = Collator.PRIMARY
        decomposition = Collator.CANONICAL_DECOMPOSITION
    }
    val names = items.associate { id(it) to Normalizer.normalize(label(it).trim(), Normalizer.Form.NFKC) }
    return items.sortedWith { left, right ->
        val nameOrder = naturalNameCompare(names.getValue(id(left)), names.getValue(id(right)), collator)
        val primary = when (sort) {
            NavigationSort.CreatedNewest -> newestFirst(createdAt(left), createdAt(right))
            NavigationSort.UpdatedNewest -> newestFirst(updatedAt(left), updatedAt(right))
            NavigationSort.NameAscending -> nameOrder
            NavigationSort.NameDescending -> -nameOrder
        }
        if (primary != 0) primary else {
            val dateFallback = if (sort == NavigationSort.CreatedNewest || sort == NavigationSort.UpdatedNewest) nameOrder else 0
            if (dateFallback != 0) dateFallback else id(left).compareTo(id(right))
        }
    }
}

private fun newestFirst(left: Long?, right: Long?): Int = when {
    left == null -> if (right == null) 0 else 1
    right == null -> -1
    else -> right.compareTo(left)
}

/** Numeric runs are compared by magnitude, never parsed into an overflowing integer. */
private fun naturalNameCompare(left: String, right: String, collator: Collator): Int {
    var a = 0
    var b = 0
    while (a < left.length && b < right.length) {
        val digitsA = left[a] in '0'..'9'
        val digitsB = right[b] in '0'..'9'
        var endA = a + 1
        var endB = b + 1
        while (endA < left.length && (left[endA] in '0'..'9') == digitsA) endA++
        while (endB < right.length && (right[endB] in '0'..'9') == digitsB) endB++
        val runA = left.substring(a, endA)
        val runB = right.substring(b, endB)
        val order = if (digitsA && digitsB) {
            val numberA = runA.trimStart('0').ifEmpty { "0" }
            val numberB = runB.trimStart('0').ifEmpty { "0" }
            numberA.length.compareTo(numberB.length).takeIf { it != 0 }
                ?: numberA.compareTo(numberB).takeIf { it != 0 }
                ?: runA.length.compareTo(runB.length)
        } else collator.compare(runA, runB).coerceIn(-1, 1)
        if (order != 0) return order.coerceIn(-1, 1)
        a = endA
        b = endB
    }
    return (left.length - a).compareTo(right.length - b).coerceIn(-1, 1)
}
