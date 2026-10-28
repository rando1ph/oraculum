package dev.oraculum.poc

// Pure policy shared by the Activity and local JVM tests. The system grants
// temporary content access; the Bridge separately validates bytes and names.
object AttachmentPickerPolicy {
    const val maxFiles = 6
    val mimeTypes = arrayOf(
        "image/png", "image/jpeg", "image/webp", "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/csv", "text/plain", "text/markdown"
    )
    fun acceptsRequest(types: List<String>, openMode: Boolean, capture: Boolean): Boolean =
        openMode && !capture && types.flatMap { it.split(",") }.map { it.trim() }.toSet() == mimeTypes.toSet()

    data class Selection(val value: String, val scheme: String?, val authority: String?, val mime: String?, val ownProvider: Boolean)
    fun acceptsResult(items: List<Selection>, multiple: Boolean, grantedRead: Boolean, trustedOwner: Boolean): Boolean =
        trustedOwner && grantedRead && items.isNotEmpty() && items.size <= (if (multiple) maxFiles else 1) &&
            items.map { it.value }.toSet().size == items.size && items.all {
                it.scheme == "content" && !it.authority.isNullOrEmpty() && !it.ownProvider && it.mime in mimeTypes
            }
}
