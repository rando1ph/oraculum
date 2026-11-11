package dev.oraculum.poc.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.oraculum.poc.repository.*
import kotlinx.serialization.json.*

/** Fields live only in composition: secret answers are never saved in a Bundle, cache or draft. */
@Composable
fun NativeInteractionPanel(interaction: InteractionUi, enabled: Boolean, onRespond: (JsonObject) -> Unit) {
    key(interaction.id, interaction.epoch, interaction.generation, interaction.status) {
        // ViewModel serializes attempts and publishes busy/unknown state. A tap is not
        // evidence of delivery: read-only preflight can fail before a write is reserved.
        val actionable = NativeInteractionForms.canRespond(interaction, enabled)
        val send: (JsonObject) -> Unit = { response ->
            if (actionable && NativeInteractionForms.validate(interaction, response)) onRespond(response)
        }
        Card(
            modifier = Modifier.fillMaxWidth().testTag("interaction_${interaction.id}"),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(interaction.title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                if (interaction.description.isNotBlank()) SelectionContainer { Text(interaction.description, style = MaterialTheme.typography.bodyMedium) }
                when {
                    !interaction.supported -> Text("此原生请求含当前客户端无法安全处理的约束，请在宿主机检查。", color = MaterialTheme.colorScheme.error)
                    interaction.status == "unknown" -> Text("响应送达结果未知。请刷新原生状态；不会重复提交。", color = MaterialTheme.colorScheme.error)
                    interaction.status == "submitted" -> Text("响应已提交，等待原生状态确认。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    interaction.status == "resolved" -> Text("该请求已处理或取消。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    !enabled -> Text("当前不可响应。连接和原生状态恢复后再操作。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                NativeRequestDetails(interaction)
                if (interaction.supported) {
                    when (interaction.kind) {
                        "command", "fileChange", "permissions" -> {
                            for (decision in interaction.decisions) {
                                OutlinedButton(
                                    onClick = { send(buildJsonObject { put("type", "approval"); put("decision", decision) }) },
                                    enabled = actionable,
                                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("interaction_${interaction.id}_$decision"),
                                ) { Text(decisionLabel(decision, interaction.kind)) }
                            }
                        }
                        "input" -> NativeInputQuestions(interaction, actionable, send)
                        "elicitation" -> NativeElicitation(interaction, actionable, send)
                    }
                }
            }
        }
    }
}

@Composable
private fun NativeRequestDetails(interaction: InteractionUi) {
    val request = interaction.request
    if (interaction.kind == "command") {
        val details = NativeInteractionForms.commandApprovalDetails(request)
        if (details != null) {
            Text(if (details.networkHost != null) "操作：允许此原生请求访问网络目标" else "操作：执行命令", style = MaterialTheme.typography.bodyMedium)
            if (details.networkHost != null) SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("目标主机：${details.networkHost}", style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                    Text("网络协议：${details.networkProtocol}", style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                }
            }
        } else {
            val nativeKind = (request["kind"] as? JsonPrimitive)?.content ?: "command"
            Text("原生操作类型：$nativeKind；请求语义尚无法完整呈现，不能在此授权。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
    }
    for ((label, key) in listOf("命令" to "command", "工作目录" to "cwd", "运行环境" to "environmentId", "授权范围" to "grantRoot")) {
        val value = (request[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (!value.isNullOrBlank()) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SelectionContainer {
                Text(value, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerLowest, RoundedCornerShape(8.dp))
                    .horizontalScroll(rememberScrollState()).padding(12.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
    if (interaction.kind == "permissions") {
        Text("接受仅授予这次原生请求列出的权限，作用域为当前轮次。", style = MaterialTheme.typography.bodySmall)
        val permissions = request["permissions"] as? JsonObject
        val network = permissions?.get("network") as? JsonObject
        val enabled = (network?.get("enabled") as? JsonPrimitive)?.booleanOrNull
        if (enabled != null) Text("网络访问：${if (enabled) "允许" else "关闭"}", style = MaterialTheme.typography.bodyMedium)
        val files = permissions?.get("fileSystem") as? JsonObject
        for ((label, key) in listOf("读取" to "read", "写入" to "write")) {
            val paths = files?.get(key) as? JsonArray ?: continue
            if (paths.isNotEmpty()) SelectionContainer {
                Text("$label：\n${paths.mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.content }.joinToString("\n")}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun NativeInputQuestions(interaction: InteractionUi, enabled: Boolean, onRespond: (JsonObject) -> Unit) {
    val selected = remember { mutableStateMapOf<String, List<String>>() }
    val other = remember { mutableStateMapOf<String, String>() }
    val payload = buildJsonObject {
        put("type", "input")
        put("answers", buildJsonObject {
            interaction.questions.forEach { question ->
                val choices = selected[question.id].orEmpty()
                val typed = other[question.id].orEmpty()
                val values = (choices + if (typed.isNotEmpty()) listOf(typed) else emptyList()).distinct()
                if (values.isNotEmpty()) put(question.id, JsonArray(values.map(::JsonPrimitive)))
            }
        })
    }
    for (question in interaction.questions) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (question.header.isNotBlank()) Text(question.header, style = MaterialTheme.typography.titleSmall)
            Text(question.question, style = MaterialTheme.typography.bodyMedium)
            for ((index, option) in question.options.withIndex()) {
                val checked = option.label in selected[question.id].orEmpty()
                ChoiceRow(option.label, option.description, checked, enabled,
                    Modifier.testTag("interaction_${interaction.id}_question_${question.id}_$index")) { chosen ->
                    selected[question.id] = if (chosen) (selected[question.id].orEmpty() + option.label).distinct()
                    else selected[question.id].orEmpty() - option.label
                }
            }
            if (question.options.isEmpty() || question.isOther) {
                OutlinedTextField(
                    value = other[question.id].orEmpty(), onValueChange = { other[question.id] = it }, enabled = enabled,
                    modifier = Modifier.fillMaxWidth().testTag("interaction_${interaction.id}_question_${question.id}_text"),
                    label = { Text(if (question.options.isEmpty()) "回答" else "其他回答") },
                    visualTransformation = if (question.isSecret) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(keyboardType = if (question.isSecret) KeyboardType.Password else KeyboardType.Text),
                    singleLine = question.isSecret, maxLines = if (question.isSecret) 1 else 5,
                )
                if (question.isSecret) Text("敏感回答仅保留在当前表单中，不写入草稿或缓存。", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
    val valid = NativeInteractionForms.validate(interaction, payload)
    if (enabled && !valid) Text("回答超出原生限制：每题至多 20 项、每项至多 16,000 个字符，总量至多 128 KiB。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    Button(onClick = { onRespond(payload) }, enabled = enabled && valid,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("interaction_${interaction.id}_submit")) { Text("提交回答") }
}

@Composable
private fun NativeElicitation(interaction: InteractionUi, enabled: Boolean, onRespond: (JsonObject) -> Unit) {
    val included = remember { mutableStateMapOf<String, Boolean>().apply {
        interaction.fields.forEach { put(it.id, it.required || it.defaultValue != null) }
    } }
    val values = remember { mutableStateMapOf<String, JsonElement>().apply {
        interaction.fields.forEach { field ->
            val initial = field.defaultValue ?: when (field.type) {
                "string" -> if (field.options == null) JsonPrimitive("") else null
                "array" -> JsonArray(emptyList())
                else -> null
            }
            if (initial != null) put(field.id, initial)
        }
    } }
    val uriHandler = LocalUriHandler.current
    var openError by remember { mutableStateOf(false) }
    if (interaction.url != null) {
        SelectionContainer { Text(interaction.url, style = MaterialTheme.typography.bodySmall) }
        OutlinedButton(onClick = { openError = runCatching { uriHandler.openUri(interaction.url) }.isFailure }, enabled = enabled,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("在浏览器打开请求链接") }
        if (openError) Text("没有可用浏览器，请在宿主机处理此请求。", color = MaterialTheme.colorScheme.error)
        Text("在外部完成请求后，再提交确认。", style = MaterialTheme.typography.bodySmall)
    } else {
        interaction.fields.forEach { field ->
            if (!field.required) ChoiceRow("填写 ${field.label}", "可选字段", included[field.id] == true, enabled) { included[field.id] = it }
            if (field.required || included[field.id] == true) NativeElicitationField(field, values[field.id], enabled,
                Modifier.testTag("interaction_${interaction.id}_field_${field.id}")) { next ->
                if (next == null) values.remove(field.id) else values[field.id] = next
            }
        }
    }
    val content = if (interaction.url != null || interaction.request["requestedSchema"] == JsonNull) JsonNull else buildJsonObject {
        interaction.fields.filter { it.required || included[it.id] == true }.forEach { field -> values[field.id]?.let { put(field.id, it) } }
    }
    val accept = buildJsonObject { put("type", "elicitation"); put("action", "accept"); put("content", content) }
    // An explicitly enabled optional field must also be valid, even though omission is allowed by the schema.
    val fieldsValid = interaction.fields.filter { it.required || included[it.id] == true }
        .all { field -> values[field.id]?.let { NativeInteractionForms.validFieldValue(field, it) } == true }
    Button(onClick = { onRespond(accept) }, enabled = enabled && fieldsValid && NativeInteractionForms.validate(interaction, accept),
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("interaction_${interaction.id}_accept")) { Text("确认并提交") }
    for (action in listOf("decline", "cancel")) {
        OutlinedButton(onClick = { onRespond(buildJsonObject { put("type", "elicitation"); put("action", action); put("content", JsonNull) }) },
            enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("interaction_${interaction.id}_$action")) {
            Text(decisionLabel(action, interaction.kind))
        }
    }
}

@Composable
private fun NativeElicitationField(field: ElicitationFieldUi, value: JsonElement?, enabled: Boolean, modifier: Modifier, onChange: (JsonElement?) -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(field.label + if (field.required) " *" else "", style = MaterialTheme.typography.titleSmall)
        field.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        when {
            field.type == "boolean" -> {
                for ((label, selection) in listOf("是" to true, "否" to false)) {
                    RadioChoice(label, (value as? JsonPrimitive)?.booleanOrNull == selection, enabled) { onChange(JsonPrimitive(selection)) }
                }
            }
            field.type == "array" -> {
                val selected = (value as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty()
                for (option in field.options.orEmpty()) ChoiceRow(option.label, "", option.value in selected, enabled) { checked ->
                    val next = if (checked) (selected + option.value).distinct() else selected - option.value
                    onChange(JsonArray(next.map(::JsonPrimitive)))
                }
            }
            field.options != null -> field.options.forEach { option ->
                RadioChoice(option.label, (value as? JsonPrimitive)?.content == option.value, enabled) { onChange(JsonPrimitive(option.value)) }
            }
            else -> {
                var raw by remember(field.id) { mutableStateOf((value as? JsonPrimitive)?.content.orEmpty()) }
                OutlinedTextField(value = raw, onValueChange = { raw = it; onChange(NativeInteractionForms.fieldValue(field, it)) }, enabled = enabled,
                    modifier = Modifier.fillMaxWidth(), label = { Text(field.label) },
                    keyboardOptions = KeyboardOptions(keyboardType = when (field.type) {
                        "integer", "number" -> KeyboardType.Decimal
                        else -> when (field.format) { "email" -> KeyboardType.Email; "uri" -> KeyboardType.Uri; else -> KeyboardType.Text }
                    }), maxLines = if (field.type == "string" && field.format == null) 5 else 1,
                    isError = raw.isNotEmpty() && (value == null || !NativeInteractionForms.validFieldValue(field, value)),
                )
            }
        }
        val constraints = buildList {
            field.minimum?.let { add("最小值 $it") }; field.maximum?.let { add("最大值 $it") }
            field.minLength?.let { add("至少 $it 个字符") }; field.maxLength?.let { add("至多 $it 个字符") }
            field.minItems?.let { add("至少选择 $it 项") }; field.maxItems?.let { add("至多选择 $it 项") }
            field.format?.let { add("格式 $it") }
        }
        if (constraints.isNotEmpty()) Text(constraints.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (value != null && !NativeInteractionForms.validFieldValue(field, value)) Text("请按字段约束填写。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun ChoiceRow(label: String, description: String, checked: Boolean, enabled: Boolean, modifier: Modifier = Modifier, onChange: (Boolean) -> Unit) {
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Column(Modifier.weight(1f).padding(start = 8.dp, top = 6.dp, bottom = 6.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun RadioChoice(label: String, checked: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = checked, enabled = enabled, role = Role.RadioButton, onClick = onSelect),
        verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = checked, onClick = null, enabled = enabled)
        Text(label, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodyMedium)
    }
}

private fun decisionLabel(value: String, kind: String): String = when (value) {
    "accept" -> if (kind == "permissions") "授权本轮" else "允许本次"
    "decline" -> "拒绝"
    "cancel" -> "取消"
    else -> value
}
