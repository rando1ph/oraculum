package dev.oraculum.poc.repository

import java.net.URI
import java.time.LocalDate
import java.time.OffsetDateTime
import kotlinx.serialization.json.*

/** Only the Gateway's supported, current native interaction subset is actionable. */
data class InteractionUi(
    val id: String,
    val projectId: String,
    val threadId: String,
    val epoch: String,
    val generation: Long,
    val kind: String,
    val status: String,
    val title: String,
    val description: String,
    val decisions: List<String> = emptyList(),
    val questions: List<InteractionQuestionUi> = emptyList(),
    val fields: List<ElicitationFieldUi> = emptyList(),
    val url: String? = null,
    val supported: Boolean = true,
    val request: JsonObject = JsonObject(emptyMap()),
    val fileChangeContext: FileChangeApprovalContext? = null,
)

/** Display facts from the stable native command/network approval fields. */
data class CommandApprovalDetails(val command: String?, val networkHost: String?, val networkProtocol: String?)

data class InteractionQuestionUi(
    val id: String,
    val header: String,
    val question: String,
    val isOther: Boolean = false,
    val isSecret: Boolean = false,
    val options: List<InteractionOptionUi> = emptyList(),
)
data class InteractionOptionUi(val label: String, val description: String)
data class ElicitationOptionUi(val value: String, val label: String)
data class ElicitationFieldUi(
    val id: String,
    val label: String,
    val description: String? = null,
    val required: Boolean = false,
    val type: String,
    val options: List<ElicitationOptionUi>? = null,
    val defaultValue: JsonElement? = null,
    val minimum: Double? = null,
    val maximum: Double? = null,
    val minLength: Long? = null,
    val maxLength: Long? = null,
    val minItems: Long? = null,
    val maxItems: Long? = null,
    val format: String? = null,
)

/** Mirrors gateway/src/interactions.ts and packages/shared/elicitation.ts; unknown constraints fail closed. */
object NativeInteractionForms {
    private val decisions = listOf("accept", "decline", "cancel")
    private val formModes = setOf("form", "openai/form", "openaiForm")
    private const val MAX_BYTES = 128 * 1024
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

    fun parse(value: JsonObject, context: FileChangeApprovalContext? = null): InteractionUi {
        val request = value["request"] as? JsonObject ?: JsonObject(emptyMap())
        val kind = value.text("kind").orEmpty()
        val status = value.text("status").orEmpty()
        val available = request["availableDecisions"]
        val nativeAllowed = if (available == null) decisions else (available as? JsonArray)?.mapNotNull { it.stringValue() }
            ?.filter { it in decisions }?.distinct().orEmpty()
        // Request IDs alone prove no patch. Positive approval requires complete current Item facts.
        val boundContext = context?.takeIf { it.matchesRequest(value.text("epoch"), value.text("projectId"),
            value.text("threadId"), kind, status, request) && it.matchesIdentity(value.text("interactionId"), (value["generation"] as? JsonPrimitive)?.longOrNull) }
        val allowed = nativeAllowed.filter { kind != "fileChange" || it != "accept" || boundContext != null }
        val questions = if (kind == "input") questions(request) else emptyList()
        val fields = if (kind == "elicitation" && request.text("mode") in formModes) elicitationFields(request["requestedSchema"]) else emptyList()
        val title = when (kind) {
            "command" -> when (request.text("kind")) {
                "writeStdin" -> "终端输入审批（当前不支持）"
                "humanCommand" -> "人工命令审批（当前不支持）"
                else -> if (request["networkApprovalContext"] is JsonObject) "网络访问审批" else "命令审批"
            }
            "fileChange" -> if (boundContext != null) "文件修改审批" else "文件修改审批（当前仅可拒绝或取消）"
            "permissions" -> "权限审批（仅本轮）"
            "input" -> "需要你的回答"
            "elicitation" -> request.text("serverName")?.let { "$it 请求确认" } ?: "扩展请求确认"
            else -> "暂不支持的交互"
        }
        val description = listOfNotNull(request.text("reason"), request.text("message"))
            .filter { it.isNotBlank() }.distinct().joinToString("\n")
        val identityValid = listOf("interactionId", "projectId", "threadId", "epoch").all { identifier(value[it]) } &&
            (value["generation"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull?.let { it > 0 } == true &&
            status in setOf("pending", "submitted", "unknown", "resolved") && value["request"] is JsonObject &&
            value.text("threadId") == request.text("threadId")
        val supported = identityValid && validRequest(kind, request) &&
            (kind !in setOf("command", "fileChange", "permissions") || allowed.isNotEmpty())
        return InteractionUi(
            id = value.text("interactionId").orEmpty(), projectId = value.text("projectId").orEmpty(),
            threadId = value.text("threadId").orEmpty(), epoch = value.text("epoch").orEmpty(),
            generation = (value["generation"] as? JsonPrimitive)?.longOrNull ?: 0,
            kind = kind, status = status, title = title, description = description,
            decisions = if (kind in setOf("command", "fileChange", "permissions")) allowed else decisions,
            questions = questions.orEmpty(), fields = fields.orEmpty(),
            url = request.text("url")?.takeIf { kind == "elicitation" && request.text("mode") == "url" && safeWebUrl(it) },
            supported = supported, request = request, fileChangeContext = boundContext,
        )
    }

    /** Rebuild from original native fields; revoked evidence never leaves a stale accept option. */
    fun bindFileChangeContext(interaction: InteractionUi, context: FileChangeApprovalContext?): InteractionUi = parse(buildJsonObject {
        put("interactionId", interaction.id); put("projectId", interaction.projectId); put("threadId", interaction.threadId)
        put("epoch", interaction.epoch); put("generation", interaction.generation); put("kind", interaction.kind)
        put("status", interaction.status); put("request", interaction.request)
    }, context)

    /**
     * Codex stable v2 CommandExecutionRequestApprovalParams.kind defaults to command;
     * NetworkApprovalContext supplies host and NetworkApprovalProtocol. Terminal-input
     * variants require a different renderer and must not inherit command approval UI.
     * Source: openai/codex codex-rs/app-server-protocol/schema/typescript/v2/.
     */
    fun commandApprovalDetails(request: JsonObject): CommandApprovalDetails? {
        if (request.containsKey("kind") && request.text("kind") != "command") return null
        val command = request["command"]
        if (command != null && command != JsonNull && !text(command, 64_000)) return null
        val displayedCommand = command.stringValue()?.takeIf { it.isNotBlank() }
        val network = request["networkApprovalContext"]
        if (network == null || network == JsonNull) {
            return displayedCommand?.let { CommandApprovalDetails(it, null, null) }
        }
        if (network !is JsonObject || !network.keysWithin("host", "protocol") || !identifier(network["host"]) ||
            network.text("host")!!.any { it.isWhitespace() } ||
            network.text("protocol") !in setOf("http", "https", "socks5Tcp", "socks5Udp")) return null
        return CommandApprovalDetails(displayedCommand, network.text("host"), network.text("protocol"))
    }

    /** The owner supplies its live connection, operation/busy and unknown barrier state. */
    fun canRespond(interaction: InteractionUi, enabled: Boolean): Boolean =
        enabled && interaction.supported && interaction.status == "pending"

    fun validate(interaction: InteractionUi, response: JsonObject): Boolean {
        if (!interaction.supported || interaction.status != "pending" || !validRequest(interaction.kind, interaction.request)) return false
        return when (interaction.kind) {
            "command", "fileChange", "permissions" -> response.keysWithin("type", "decision") &&
                response.text("type") == "approval" && response.text("decision") in interaction.decisions &&
                (interaction.kind != "fileChange" || response.text("decision") != "accept" || interaction.fileChangeContext?.matchesPending(interaction) == true) &&
                response.text("decision") in decisions && (interaction.request["availableDecisions"] == null ||
                (interaction.request["availableDecisions"] as? JsonArray)?.any { it.stringValue() == response.text("decision") } == true)
            "input" -> {
                val answers = response["answers"] as? JsonObject ?: return false
                if (!response.keysWithin("type", "answers") || response.text("type") != "input" || answers.size > 20) return false
                val nativeQuestions = questions(interaction.request) ?: return false
                answers.all { (id, values) ->
                    val question = nativeQuestions.firstOrNull { it.id == id }
                    question != null && values is JsonArray && values.size <= 20 && values.all { value ->
                        text(value) && (question.options.isEmpty() || question.isOther || question.options.any { it.label == value.stringValue() })
                    }
                } && buildJsonObject {
                    answers.forEach { (id, values) -> put(id, buildJsonObject { put("answers", values) }) }
                }.byteSize() <= MAX_BYTES
            }
            "elicitation" -> {
                val action = response.text("action")
                if (!response.keysWithin("type", "action", "content") || response.text("type") != "elicitation" || action !in decisions) return false
                val content = response["content"] ?: JsonNull
                (if (action != "accept" || interaction.request.text("mode") == "url") content == JsonNull
                else validElicitationContent(interaction.request["requestedSchema"], content)) && content.byteSize() <= MAX_BYTES
            }
            else -> false
        }
    }

    fun elicitationFields(schema: JsonElement?): List<ElicitationFieldUi>? {
        if (schema == JsonNull) return emptyList()
        if (schema !is JsonObject || schema.text("type") != "object" || schema["properties"] !is JsonObject ||
            !schema.keysWithin("\$schema", "type", "properties", "required", "title", "description", "additionalProperties") ||
            (schema.containsKey("additionalProperties") && !boolean(schema["additionalProperties"])) ||
            (schema.containsKey("required") && !strings(schema["required"]))) return null
        val properties = schema.getValue("properties") as JsonObject
        val required = (schema["required"] as? JsonArray)?.map { it.stringValue()!! }.orEmpty()
        if (required.any { !properties.containsKey(it) }) return null
        val fields = mutableListOf<ElicitationFieldUi>()
        for ((id, element) in properties) {
            val property = element as? JsonObject ?: return null
            val type = property.text("type") ?: return null
            val allowed = when (type) {
                "string" -> arrayOf("minLength", "maxLength", "format", "enum", "enumNames", "oneOf")
                "number", "integer" -> arrayOf("minimum", "maximum")
                "array" -> arrayOf("items", "minItems", "maxItems")
                "boolean" -> emptyArray()
                else -> return null
            }
            if (!property.keysWithin("type", "title", "description", "default", *allowed) ||
                listOf("title", "description").any { property.containsKey(it) && property.text(it) == null }) return null
            for (key in listOf("minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems")) {
                if (!property.containsKey(key)) continue
                val value = property[key].finiteNumber() ?: return null
                if (key !in setOf("minimum", "maximum") && (value < 0 || value > MAX_SAFE_INTEGER || value % 1.0 != 0.0)) return null
            }
            val format = property.text("format")
            if (property.containsKey("format") && format !in setOf("email", "uri", "date", "date-time")) return null
            var options: List<ElicitationOptionUi>? = null
            if (property.containsKey("enum")) {
                if (!strings(property["enum"])) return null
                val values = property.getValue("enum") as JsonArray
                val names = property["enumNames"]
                if (names != null && (!strings(names) || (names as JsonArray).size != values.size)) return null
                options = values.mapIndexed { index, value -> ElicitationOptionUi(value.stringValue()!!,
                    (names as? JsonArray)?.get(index)?.stringValue() ?: value.stringValue()!!) }
            }
            if (property.containsKey("oneOf")) {
                if (options != null) return null
                options = choices(property["oneOf"]) ?: return null
            }
            if (type == "array") {
                val items = property["items"] as? JsonObject ?: return null
                options = if (items.text("type") == "string" && strings(items["enum"]) && items.keysWithin("type", "enum")) {
                    (items.getValue("enum") as JsonArray).map { ElicitationOptionUi(it.stringValue()!!, it.stringValue()!!) }
                } else if (items.keysWithin("anyOf")) choices(items["anyOf"]) ?: return null
                else return null
            }
            val field = ElicitationFieldUi(id = id, label = property.text("title") ?: id, description = property.text("description"),
                required = id in required, type = type, options = options,
                minimum = property["minimum"].finiteNumber(), maximum = property["maximum"].finiteNumber(),
                minLength = property["minLength"].finiteNumber()?.toLong(), maxLength = property["maxLength"].finiteNumber()?.toLong(),
                minItems = property["minItems"].finiteNumber()?.toLong(), maxItems = property["maxItems"].finiteNumber()?.toLong(), format = format)
            val defaultValue = property["default"]
            if (defaultValue != null && !validFieldValue(field, defaultValue)) return null
            fields += field.copy(defaultValue = defaultValue)
        }
        return fields
    }

    fun validElicitationContent(schema: JsonElement?, content: JsonElement): Boolean {
        val fields = elicitationFields(schema) ?: return false
        if (schema == JsonNull) return content == JsonNull || (content is JsonObject && content.isEmpty())
        if (content !is JsonObject || content.keys.any { id -> fields.none { it.id == id } }) return false
        return fields.all { field -> content[field.id]?.let { validFieldValue(field, it) } ?: !field.required }
    }

    fun validFieldValue(field: ElicitationFieldUi, value: JsonElement): Boolean {
        return when (field.type) {
            "boolean" -> boolean(value)
            "number", "integer" -> value.finiteNumber()?.let { number ->
                (field.type != "integer" || number % 1.0 == 0.0) &&
                    (field.minimum == null || number >= field.minimum) && (field.maximum == null || number <= field.maximum)
            } ?: false
            "array" -> {
                if (!strings(value)) return false
                val values = (value as JsonArray).map { it.stringValue()!! }
                values.distinct().size == values.size && values.all { entry -> field.options?.any { it.value == entry } == true } &&
                    (field.minItems == null || values.size >= field.minItems) && (field.maxItems == null || values.size <= field.maxItems)
            }
            "string" -> {
                val content = value.stringValue() ?: return false
                val count = content.codePointCount(0, content.length)
                if ((field.minLength != null && count < field.minLength) || (field.maxLength != null && count > field.maxLength) ||
                    (field.options != null && field.options.none { it.value == content })) return false
                when (field.format) {
                    "email" -> Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(content)
                    "uri" -> runCatching { URI(content).isAbsolute }.getOrDefault(false)
                    "date" -> Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(content) && runCatching { LocalDate.parse(content).toString() == content }.getOrDefault(false)
                    "date-time" -> Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$", RegexOption.IGNORE_CASE).matches(content) &&
                        runCatching { OffsetDateTime.parse(content.uppercase()); true }.getOrDefault(false)
                    else -> true
                }
            }
            else -> false
        }
    }

    /** Converts a UI value without coercing strings to booleans or invalid numeric input to zero. */
    fun fieldValue(field: ElicitationFieldUi, text: String, checked: Boolean = false, selected: List<String> = emptyList()): JsonElement? =
        when (field.type) {
            "boolean" -> JsonPrimitive(checked)
            "array" -> JsonArray(selected.map(::JsonPrimitive))
            "number", "integer" -> if (Regex("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$").matches(text))
                runCatching { Json.parseToJsonElement(text) }.getOrNull()?.takeIf { it.finiteNumber() != null } else null
            "string" -> JsonPrimitive(text)
            else -> null
        }

    private fun validRequest(kind: String, request: JsonObject): Boolean {
        if (!identifier(request["threadId"]) || request.byteSize() > MAX_BYTES) return false
        return when (kind) {
            "command" -> identifier(request["turnId"]) && identifier(request["itemId"]) && commandApprovalDetails(request) != null &&
                (request["cwd"] == null || request["cwd"] == JsonNull || identifier(request["cwd"])) &&
                (request["availableDecisions"] == null || (request["availableDecisions"] is JsonArray &&
                    (request["availableDecisions"] as JsonArray).all { it.stringValue() != null || it is JsonObject }))
            "fileChange" -> identifier(request["turnId"]) && identifier(request["itemId"])
            "permissions" -> identifier(request["turnId"]) && identifier(request["itemId"]) && identifier(request["cwd"]) && validPermissions(request["permissions"])
            "input" -> identifier(request["turnId"]) && identifier(request["itemId"]) && boolean(request["isBlocking"]) && questions(request) != null
            "elicitation" -> (request["turnId"] == JsonNull || identifier(request["turnId"])) && identifier(request["serverName"]) && text(request["message"]) &&
                (if (request.text("mode") in formModes) elicitationFields(request["requestedSchema"]) != null
                else request.text("mode") == "url" && identifier(request["elicitationId"]) && text(request["url"]) && safeWebUrl(request.text("url").orEmpty()))
            else -> false
        }
    }

    private fun questions(request: JsonObject): List<InteractionQuestionUi>? {
        val values = request["questions"] as? JsonArray ?: return null
        if (values.size > 20) return null
        val result = mutableListOf<InteractionQuestionUi>()
        for (value in values) {
            val question = value as? JsonObject ?: return null
            if (!identifier(question["id"]) || !text(question["header"]) || !text(question["question"]) ||
                listOf("isOther", "isSecret").any { question.containsKey(it) && !boolean(question[it]) }) return null
            val options = question["options"]
            if (options != null && options != JsonNull && (options !is JsonArray || options.size > 100)) return null
            val parsed = mutableListOf<InteractionOptionUi>()
            for (element in options as? JsonArray ?: JsonArray(emptyList())) {
                val option = element as? JsonObject ?: return null
                if (!text(option["label"]) || !text(option["description"])) return null
                parsed += InteractionOptionUi(option.text("label")!!, option.text("description")!!)
            }
            result += InteractionQuestionUi(question.text("id")!!, question.text("header")!!, question.text("question")!!,
                (question["isOther"] as? JsonPrimitive)?.booleanOrNull == true, (question["isSecret"] as? JsonPrimitive)?.booleanOrNull == true, parsed)
        }
        return result.takeIf { result.map { it.id }.distinct().size == result.size }
    }

    private fun validPermissions(element: JsonElement?): Boolean {
        val value = element as? JsonObject ?: return false
        if (!value.keysWithin("network", "fileSystem")) return false
        val network = value["network"]
        if (network != null && network != JsonNull && (network !is JsonObject || !network.keysWithin("enabled") ||
            (network["enabled"] != JsonNull && !boolean(network["enabled"])))) return false
        val fileSystem = value["fileSystem"]
        if (fileSystem != null && fileSystem != JsonNull) {
            if (fileSystem !is JsonObject || !fileSystem.keysWithin("read", "write")) return false
            for (key in listOf("read", "write")) {
                val paths = fileSystem[key]
                if (paths != null && paths != JsonNull && (paths !is JsonArray || paths.size > 64 ||
                    !paths.all { identifier(it) && it.stringValue()!!.startsWith("/") })) return false
            }
        }
        return true
    }

    private fun choices(value: JsonElement?): List<ElicitationOptionUi>? {
        val values = value as? JsonArray ?: return null
        return values.map { item ->
            if (item !is JsonObject || !item.keysWithin("const", "title") || item.text("const") == null || item.text("title") == null) return null
            ElicitationOptionUi(item.text("const")!!, item.text("title")!!)
        }
    }
    private fun safeWebUrl(value: String): Boolean = runCatching {
        val uri = URI(value)
        uri.scheme?.lowercase() in setOf("http", "https") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null
    }.getOrDefault(false)
    private fun JsonObject.keysWithin(vararg allowed: String): Boolean = keys.all { it in allowed }
    private fun JsonObject.text(key: String): String? = get(key).stringValue()
    private fun JsonElement?.stringValue(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonElement?.finiteNumber(): Double? = (this as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
    private fun text(value: JsonElement?, max: Int = 16_000): Boolean = value.stringValue()?.let { it.length <= max } == true
    private fun identifier(value: JsonElement?): Boolean = value.stringValue()?.let { it.isNotEmpty() && it.length <= 4096 && it.none { char -> char.code in 0..31 } } == true
    private fun boolean(value: JsonElement?): Boolean = (value as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull != null
    private fun strings(value: JsonElement?): Boolean = value is JsonArray && value.all { it.stringValue() != null }
    private fun JsonElement.byteSize(): Int = toString().toByteArray(Charsets.UTF_8).size
}
