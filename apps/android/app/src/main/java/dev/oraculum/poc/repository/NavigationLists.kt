package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.ProjectOption
import dev.oraculum.poc.ui.ThreadOption
import kotlinx.serialization.json.*
import java.text.Collator
import java.text.Normalizer
import java.util.Locale

/** Projects always use the same case-insensitive, Chinese-aware ascending name order. */
fun sortedProjects(items: List<ProjectOption>): List<ProjectOption> {
    val collator = Collator.getInstance(Locale.SIMPLIFIED_CHINESE).apply {
        strength = Collator.PRIMARY
        decomposition = Collator.CANONICAL_DECOMPOSITION
    }
    val names = items.associate { it.id to Normalizer.normalize(it.label.trim(), Normalizer.Form.NFKC) }
    return items.sortedWith { left, right ->
        naturalNameCompare(names.getValue(left.id), names.getValue(right.id), collator)
            .takeIf { it != 0 } ?: left.id.compareTo(right.id)
    }
}

/** Keep Gateway page order; unlisted local new-thread placeholders stay after all returned rows. */
fun appendThreadPage(current: List<ThreadOption>, next: List<ThreadOption>, unlisted: Set<String> = emptySet()): List<ThreadOption> =
    (current.filterNot { it.id in unlisted } + next + current.filter { it.id in unlisted }).distinctBy { it.id }

/** Preserve all fetched pages and their final cursor when locating a selected or notified thread. */
fun mergeThreadPages(current: JsonObject, next: JsonObject, unlisted: Set<String> = emptySet()): JsonObject {
    val prior = (current["threads"] as? JsonArray).orEmpty()
    fun placeholder(value: JsonElement) = (value as? JsonObject)?.string("id") in unlisted
    return JsonObject(current + next + ("threads" to JsonArray((prior.filterNot(::placeholder) +
        (next["threads"] as? JsonArray).orEmpty() + prior.filter(::placeholder)).distinctBy { (it as? JsonObject)?.get("id") })))
}

/** Only the registration projection changes; cached histories and drafts are retained. */
fun withoutRegisteredProject(data: JsonObject, projectId: String): JsonObject = JsonObject(data + ("projects" to
    JsonArray((data["projects"] as? JsonArray).orEmpty().filterNot {
        (it as? JsonObject)?.get("id") == JsonPrimitive(projectId)
    })))

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
