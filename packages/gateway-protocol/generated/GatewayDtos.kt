// Generated from schema/v2.json by quicktype-core 24.0.0; DO NOT EDIT.
// Schema SHA-256: e30983d4bee805f0ebeff389e480d790a30fd964b27cf2a447f07cc4bf4713eb
// Decode with Json { ignoreUnknownKeys = true; explicitNulls = true }.
// Keep encodeDefaults = false. Validate requests against JSON Schema.

package dev.oraculum.gateway.protocol

import kotlinx.serialization.*
import kotlinx.serialization.json.*
import kotlinx.serialization.descriptors.*
import kotlinx.serialization.encoding.*

@Serializable
data class ProtocolVersion (
    @Required
    val major: Long,

    @Required
    val minClientMinor: Long,

    @Required
    val minor: Long
)

@Serializable
data class HealthResponse (
    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    val protocolMajor: Long,

    @Required
    val status: HealthResponseStatus
)

@Serializable
enum class HealthResponseStatus(val value: String) {
    @SerialName("ok") Ok("ok");
}

@Serializable
data class GatewayError (
    @Required
    val code: String,

    val delivery: Delivery? = null,

    @Required
    val message: String,

    @SerialName("operationId")
    val operationID: String? = null,

    val reset: Boolean? = null,

    @SerialName("retryAfterMs")
    val retryAfterMS: Long? = null
)

@Serializable
enum class Delivery(val value: String) {
    @SerialName("notSent") NotSent("notSent"),
    @SerialName("sent") Sent("sent"),
    @SerialName("unknown") Unknown("unknown");
}

@Serializable
data class ErrorResponse (
    @Required
    val epoch: String,

    @Required
    val error: ErrorClass,

    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    @SerialName("requestId")
    val requestID: String
)

@Serializable
data class ErrorClass (
    @Required
    val code: String,

    val delivery: Delivery? = null,

    @Required
    val message: String,

    @SerialName("operationId")
    val operationID: String? = null,

    val reset: Boolean? = null,

    @SerialName("retryAfterMs")
    val retryAfterMS: Long? = null
)

@Serializable
data class OperationReceipt (
    val delivery: Delivery? = null,
    val errorCode: String? = null,

    @SerialName("nativeThreadId")
    val nativeThreadID: String? = null,

    @SerialName("nativeTurnId")
    val nativeTurnID: String? = null,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    val status: OperationReceiptStatus
)

@Serializable
enum class OperationReceiptStatus(val value: String) {
    @SerialName("accepted") Accepted("accepted"),
    @SerialName("rejected") Rejected("rejected"),
    @SerialName("unknown") Unknown("unknown");
}

@Serializable
data class OperationResponse (
    @Required
    val epoch: String,

    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    val operation: OperationResponseOperation,

    @Required
    @SerialName("requestId")
    val requestID: String
)

@Serializable
data class OperationResponseOperation (
    val delivery: Delivery? = null,
    val errorCode: String? = null,

    @SerialName("nativeThreadId")
    val nativeThreadID: String? = null,

    @SerialName("nativeTurnId")
    val nativeTurnID: String? = null,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    val status: OperationReceiptStatus
)

@Serializable
data class ResourceResponse (
    @Required
    val data: JsonElement?,

    @Required
    val epoch: String,

    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    @SerialName("requestId")
    val requestID: String
)

@Serializable
data class Capability (
    @Required
    val availability: Availability,

    @Required
    val epoch: String,

    @Required
    val maturity: Maturity,

    @Required
    val name: String,

    @Required
    val observedVersion: String? = null,

    @Required
    val reasonCode: String? = null,

    @Required
    val supported: Boolean,

    @Required
    val verified: Boolean
)

@Serializable
enum class Availability(val value: String) {
    @SerialName("available") Available("available"),
    @SerialName("unavailable") Unavailable("unavailable"),
    @SerialName("unsupported") Unsupported("unsupported"),
    @SerialName("unverified") Unverified("unverified");
}

@Serializable
enum class Maturity(val value: String) {
    @SerialName("default-surface") DefaultSurface("default-surface"),
    @SerialName("deprecated") Deprecated("deprecated"),
    @SerialName("experimental") Experimental("experimental"),
    @SerialName("gateway") Gateway("gateway"),
    @SerialName("under-development") UnderDevelopment("under-development");
}

@Serializable
data class Capabilities (
    @Required
    val capabilities: List<CapabilityElement>,

    @Required
    val codex: Codex,

    @Required
    val epoch: String,

    @Required
    val gatewayVersion: String,

    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    val limits: Limits,

    @Required
    val protocol: ProtocolClass
)

@Serializable
data class CapabilityElement (
    @Required
    val availability: Availability,

    @Required
    val epoch: String,

    @Required
    val maturity: Maturity,

    @Required
    val name: String,

    @Required
    val observedVersion: String? = null,

    @Required
    val reasonCode: String? = null,

    @Required
    val supported: Boolean,

    @Required
    val verified: Boolean
)

@Serializable
data class Codex (
    @Required
    val connectionState: ConnectionStateEnum,

    @Required
    val version: String? = null
)

@Serializable
enum class ConnectionStateEnum(val value: String) {
    @SerialName("connected") Connected("connected"),
    @SerialName("connecting") Connecting("connecting"),
    @SerialName("disconnected") Disconnected("disconnected");
}

@Serializable
data class Limits (
    @Required
    val attachmentBatchBytes: Long,

    @Required
    val attachmentBatchCount: Long,

    @Required
    val attachmentFileBytes: Long,

    @Required
    val eventReplayCount: Long,

    @Required
    val historyPageItems: Long,

    @Required
    val requestBytes: Long
)

@Serializable
data class ProtocolClass (
    @Required
    val major: Long,

    @Required
    val minClientMinor: Long,

    @Required
    val minor: Long
)

@Serializable
data class PairRequest (
    @Required
    val code: String,

    @Required
    val deviceCredential: String,

    @Required
    @SerialName("deviceId")
    val deviceID: String,

    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    val label: String
)

@Serializable
data class TokenRequest (
    @Required
    val deviceCredential: String,

    @Required
    @SerialName("deviceId")
    val deviceID: String,

    @Required
    @SerialName("installationId")
    val installationID: String
)

@Serializable
data class AuthResponse (
    @Required
    val accessToken: String,

    @Required
    @SerialName("deviceId")
    val deviceID: String,

    @Required
    val expiresAt: Long,

    @Required
    @SerialName("installationId")
    val installationID: String
)

@Serializable
data class SessionResponse (
    @Required
    val createdAt: Long,

    @Required
    @SerialName("deviceId")
    val deviceID: String,

    @Required
    val expiresAt: Long,

    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    val label: String
)

@Serializable
data class LogoutRequest (
    @Required
    @SerialName("operationId")
    val operationID: String
)

@Serializable
data class Root (
    @Required
    val id: String,

    @Required
    val label: String
)

@Serializable
data class Project (
    @Required
    val available: Boolean,

    @Required
    val canonicalPath: String,

    @Required
    val id: String,

    @Required
    val name: String,

    @Required
    @SerialName("rootId")
    val rootID: String
)

@Serializable
data class Projects (
    @Required
    val projects: List<ProjectElement>,

    @Required
    val roots: List<RootElement>
)

@Serializable
data class ProjectElement (
    @Required
    val available: Boolean,

    @Required
    val canonicalPath: String,

    @Required
    val id: String,

    @Required
    val name: String,

    @Required
    @SerialName("rootId")
    val rootID: String
)

@Serializable
data class RootElement (
    @Required
    val id: String,

    @Required
    val label: String
)

@Serializable
data class DirectoryQuery (
    val cursor: String? = null,
    val limit: Long? = null,
    val path: String? = null,

    @Required
    @SerialName("rootId")
    val rootID: String
)

@Serializable
data class DirectoryEntry (
    @Required
    val name: String,

    @Required
    val path: String
)

@Serializable
data class DirectoryPage (
    @Required
    val canRegister: Boolean,

    @Required
    val entries: List<EntryElement>,

    @Required
    val limited: Boolean,

    @Required
    val nextCursor: String? = null,

    @Required
    val path: String,

    @Required
    @SerialName("rootId")
    val rootID: String
)

@Serializable
data class EntryElement (
    @Required
    val name: String,

    @Required
    val path: String
)

@Serializable
data class ProjectRegisterRequest (
    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    val path: String,

    @Required
    @SerialName("rootId")
    val rootID: String
)

@Serializable
data class ProjectUnregisterRequest (
    @Required
    @SerialName("operationId")
    val operationID: String
)

@Serializable
data class ThreadStartRequest (
    val effort: String? = null,

    @Required
    val expectedEpoch: String,

    val model: String? = null,

    @Required
    @SerialName("operationId")
    val operationID: String,

    val permissionPreset: Preset? = null
)

@Serializable
enum class Preset(val value: String) {
    @SerialName("auto") Auto("auto"),
    @SerialName("full-access") FullAccess("full-access"),
    @SerialName("read-only") ReadOnly("read-only");
}

@Serializable
data class ThreadResumeRequest (
    @Required
    val expectedEpoch: String,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class ThreadQuery (
    val archived: Boolean? = null,
    val cursor: String? = null,
    val limit: Long? = null,
    val search: String? = null
)

@Serializable
data class Thread (
    val archived: Boolean? = null,
    val createdAt: Long? = null,

    @Required
    val id: String,

    val model: String? = null,

    @SerialName("parentThreadId")
    val parentThreadID: String? = null,

    val permissionPreset: String? = null,
    val permissionReadback: ThreadPermissionReadback? = null,
    val preview: String? = null,

    @Required
    @SerialName("projectId")
    val projectID: String,

    val reasoningEffort: String? = null,

    @Required
    val status: String,

    val title: String? = null,
    val updatedAt: Long? = null
)

@Serializable
data class ThreadPermissionReadback (
    @Required
    val approvalPolicy: String,

    @Required
    val observedAt: Long,

    @Required
    val preset: Preset? = null,

    @Required
    val sandboxType: String,

    @Required
    val source: PermissionReadbackSource
)

@Serializable
enum class PermissionReadbackSource(val value: String) {
    @SerialName("thread.resume") ThreadResume("thread.resume"),
    @SerialName("thread.start") ThreadStart("thread.start");
}

@Serializable
data class ThreadPage (
    @Required
    val nextCursor: String? = null,

    @Required
    val source: String,

    @Required
    val threads: List<ThreadElement>,

    @Required
    val truncated: Boolean
)

@Serializable
data class ThreadElement (
    val archived: Boolean? = null,
    val createdAt: Long? = null,

    @Required
    val id: String,

    val model: String? = null,

    @SerialName("parentThreadId")
    val parentThreadID: String? = null,

    val permissionPreset: String? = null,
    val permissionReadback: PurplePermissionReadback? = null,
    val preview: String? = null,

    @Required
    @SerialName("projectId")
    val projectID: String,

    val reasoningEffort: String? = null,

    @Required
    val status: String,

    val title: String? = null,
    val updatedAt: Long? = null
)

@Serializable
data class PurplePermissionReadback (
    @Required
    val approvalPolicy: String,

    @Required
    val observedAt: Long,

    @Required
    val preset: Preset? = null,

    @Required
    val sandboxType: String,

    @Required
    val source: PermissionReadbackSource
)

@Serializable
data class TextInput (
    @Required
    val text: String,

    @Required
    val type: TextInputType
)

@Serializable
enum class TextInputType(val value: String) {
    @SerialName("text") Text("text");
}

@Serializable
data class TurnStartRequest (
    @SerialName("attachmentIds")
    val attachmentIDS: List<String>? = null,

    @SerialName("draftId")
    val draftID: String? = null,

    val effort: String? = null,

    @Required
    val expectedEpoch: String,

    @Required
    val input: List<TurnStartRequestInput>,

    val model: String? = null,

    @Required
    @SerialName("operationId")
    val operationID: String,

    val permissionPreset: Preset? = null,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class TurnStartRequestInput (
    @Required
    val text: String,

    @Required
    val type: TextInputType
)

@Serializable
data class TurnInterruptRequest (
    @Required
    val expectedEpoch: String,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class TurnSteerRequest (
    @Required
    val expectedEpoch: String,

    @Required
    val input: List<TurnSteerRequestInput>,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class TurnSteerRequestInput (
    @Required
    val text: String,

    @Required
    val type: TextInputType
)

@Serializable
data class Turn (
    val error: GatewayErrorClass? = null,

    @Required
    val id: String,

    val items: List<ItemElement>? = null,

    @Required
    val status: String,

    @SerialName("threadId")
    val threadID: String? = null
)

@Serializable
data class GatewayErrorClass (
    @Required
    val code: String,

    val delivery: Delivery? = null,

    @Required
    val message: String,

    @SerialName("operationId")
    val operationID: String? = null,

    val reset: Boolean? = null,

    @SerialName("retryAfterMs")
    val retryAfterMS: Long? = null
)

@Serializable
data class ItemElement (
    val data: JsonElement? = null,
    val detailsAvailable: Boolean? = null,

    @Required
    val id: String,

    val text: String? = null,
    val truncated: Boolean? = null,

    @Required
    val type: String
)

@Serializable
data class NativeItem (
    val data: JsonElement? = null,
    val detailsAvailable: Boolean? = null,

    @Required
    val id: String,

    val text: String? = null,
    val truncated: Boolean? = null,

    @Required
    val type: String
)

@Serializable
data class HistoryQuery (
    val cursor: String? = null,
    val limit: Long? = null,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @SerialName("turnId")
    val turnID: String? = null
)

@Serializable
data class HistoryPage (
    @Required
    val complete: Boolean,

    @Required
    val epoch: String,

    @Required
    val historyRevision: String,

    val itemCursors: Map<String, String>? = null,

    /**
     * Optional native producer timing by native Item ID. Full-read fallback may omit it.
     */
    val itemTimings: Map<String, HistoryPageItemTiming>? = null,

    @Required
    val items: JsonArray,

    @Required
    val nextCursor: String? = null,

    @Required
    val source: HistoryPageSource,

    @Required
    val truncated: Boolean
)

@Serializable
data class HistoryPageItemTiming (
    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    @SerialName("completedAtMs")
    val completedAtMS: Long? = null,

    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    @SerialName("startedAtMs")
    val startedAtMS: Long? = null
)

@Serializable
enum class HistoryPageSource(val value: String) {
    @SerialName("native-pagination") NativePagination("native-pagination"),
    @SerialName("native-read-projection") NativeReadProjection("native-read-projection");
}

@Serializable
data class SnapshotRequest (
    val knownEpoch: String? = null,
    val knownRevision: String? = null,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class Snapshot (
    @Required
    val epoch: String,

    @Required
    val history: HistoryClass,

    @Required
    val interactions: List<InteractionElement>,

    @Required
    val observedEndSeq: Long,

    @Required
    val observedStartSeq: Long,

    @Required
    val operations: List<OperationElement>,

    @Required
    val synchronization: Synchronization,

    @Required
    val thread: SnapshotThread
)

@Serializable
data class HistoryClass (
    @Required
    val complete: Boolean,

    @Required
    val epoch: String,

    @Required
    val historyRevision: String,

    val itemCursors: Map<String, String>? = null,

    /**
     * Optional native producer timing by native Item ID. Full-read fallback may omit it.
     */
    val itemTimings: Map<String, HistoryItemTiming>? = null,

    @Required
    val items: JsonArray,

    @Required
    val nextCursor: String? = null,

    @Required
    val source: HistoryPageSource,

    @Required
    val truncated: Boolean
)

@Serializable
data class HistoryItemTiming (
    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    @SerialName("completedAtMs")
    val completedAtMS: Long? = null,

    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    @SerialName("startedAtMs")
    val startedAtMS: Long? = null
)

@Serializable
data class InteractionElement (
    @Required
    val epoch: String,

    @Required
    val generation: Long,

    @Required
    @SerialName("interactionId")
    val interactionID: String,

    @Required
    val kind: String,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    val request: JsonObject,

    @Required
    val status: InteractionStatus,

    @Required
    @SerialName("threadId")
    val threadID: String,

    @Required
    @SerialName("turnId")
    val turnID: String? = null
)

@Serializable
enum class InteractionStatus(val value: String) {
    @SerialName("pending") Pending("pending"),
    @SerialName("resolved") Resolved("resolved"),
    @SerialName("submitted") Submitted("submitted"),
    @SerialName("unknown") Unknown("unknown");
}

@Serializable
data class OperationElement (
    val delivery: Delivery? = null,
    val errorCode: String? = null,

    @SerialName("nativeThreadId")
    val nativeThreadID: String? = null,

    @SerialName("nativeTurnId")
    val nativeTurnID: String? = null,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    val status: OperationReceiptStatus
)

@Serializable
enum class Synchronization(val value: String) {
    @SerialName("current") Current("current"),
    @SerialName("stale") Stale("stale"),
    @SerialName("synchronizing") Synchronizing("synchronizing");
}

@Serializable
data class SnapshotThread (
    val archived: Boolean? = null,
    val createdAt: Long? = null,

    @Required
    val id: String,

    val model: String? = null,

    @SerialName("parentThreadId")
    val parentThreadID: String? = null,

    val permissionPreset: String? = null,
    val permissionReadback: FluffyPermissionReadback? = null,
    val preview: String? = null,

    @Required
    @SerialName("projectId")
    val projectID: String,

    val reasoningEffort: String? = null,

    @Required
    val status: String,

    val title: String? = null,
    val updatedAt: Long? = null
)

@Serializable
data class FluffyPermissionReadback (
    @Required
    val approvalPolicy: String,

    @Required
    val observedAt: Long,

    @Required
    val preset: Preset? = null,

    @Required
    val sandboxType: String,

    @Required
    val source: PermissionReadbackSource
)

@Serializable
data class ApprovalResponse (
    @Required
    val decision: Ion,

    @Required
    val type: ApprovalResponseType
)

@Serializable
enum class Ion(val value: String) {
    @SerialName("accept") Accept("accept"),
    @SerialName("cancel") Cancel("cancel"),
    @SerialName("decline") Decline("decline");
}

@Serializable
enum class ApprovalResponseType(val value: String) {
    @SerialName("approval") Approval("approval");
}

@Serializable
data class InputResponse (
    @Required
    val answers: Map<String, List<String>>,

    @Required
    val type: InputResponseType
)

@Serializable
enum class InputResponseType(val value: String) {
    @SerialName("input") Input("input");
}

@Serializable
data class ElicitationResponse (
    @Required
    val action: Ion,

    val content: JsonObject? = null,

    @Required
    val type: ElicitationResponseType
)

@Serializable
enum class ElicitationResponseType(val value: String) {
    @SerialName("elicitation") Elicitation("elicitation");
}

@Serializable
data class InteractionResponseRequest (
    @Required
    val epoch: String,

    @Required
    val generation: Long,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    val response: InteractionAnswer
)

@Serializable
data class InteractionAnswer (
    val action: Ion? = null,
    val answers: Map<String, List<String>>? = null,
    val content: JsonObject? = null,
    val decision: Ion? = null,

    @Required
    val type: InteractionAnswerType
)

@Serializable
enum class InteractionAnswerType(val value: String) {
    @SerialName("approval") Approval("approval"),
    @SerialName("elicitation") Elicitation("elicitation"),
    @SerialName("input") Input("input");
}

@Serializable
data class Interaction (
    @Required
    val epoch: String,

    @Required
    val generation: Long,

    @Required
    @SerialName("interactionId")
    val interactionID: String,

    @Required
    val kind: String,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    val request: JsonObject,

    @Required
    val status: InteractionStatus,

    @Required
    @SerialName("threadId")
    val threadID: String,

    @Required
    @SerialName("turnId")
    val turnID: String? = null
)

@Serializable
data class FilesQuery (
    val cursor: String? = null,
    val limit: Long? = null,
    val path: String? = null
)

@Serializable
data class FileEntry (
    @Required
    val directory: Boolean,

    @Required
    val mime: String,

    @Required
    val name: String,

    @Required
    val path: String,

    @Required
    val size: Long
)

@Serializable
data class FilePage (
    @Required
    val entries: List<EntryClass>,

    @Required
    val limited: Boolean,

    @Required
    val nextCursor: String? = null,

    @Required
    val path: String
)

@Serializable
data class EntryClass (
    @Required
    val directory: Boolean,

    @Required
    val mime: String,

    @Required
    val name: String,

    @Required
    val path: String,

    @Required
    val size: Long
)

@Serializable
data class FileSelectRequest (
    @Required
    val path: String,

    @SerialName("threadId")
    val threadID: String? = null
)

@Serializable
data class FileGrant (
    @Required
    val expiresAt: Long,

    @Required
    @SerialName("fileId")
    val fileID: String,

    @Required
    val mime: String,

    @Required
    val name: String,

    @Required
    val path: String,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    val size: Long,

    @SerialName("threadId")
    val threadID: String? = null
)

@Serializable
data class AttachmentUploadMetadata (
    @Required
    @SerialName("draftId")
    val draftID: String,

    @Required
    val mime: String,

    @Required
    val name: String,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    val size: Long,

    @Required
    @SerialName("threadId")
    val threadID: String
)

@Serializable
data class Attachment (
    val digest: String? = null,

    @Required
    @SerialName("draftId")
    val draftID: String,

    @Required
    val expiresAt: Long? = null,

    @Required
    val id: String,

    @Required
    val kind: AttachmentKind,

    @Required
    val mime: String,

    @Required
    val name: String,

    @SerialName("operationId")
    val operationID: String? = null,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    val size: Long,

    @Required
    val state: AttachmentState,

    @Required
    @SerialName("threadId")
    val threadID: String
)

@Serializable
enum class AttachmentKind(val value: String) {
    @SerialName("document") Document("document"),
    @SerialName("image") Image("image");
}

@Serializable
enum class AttachmentState(val value: String) {
    @SerialName("expired") Expired("expired"),
    @SerialName("held") Held("held"),
    @SerialName("ready") Ready("ready"),
    @SerialName("sent") Sent("sent"),
    @SerialName("unknown") Unknown("unknown"),
    @SerialName("uploading") Uploading("uploading");
}

@Serializable
data class AttachmentDeleteRequest (
    @Required
    @SerialName("draftId")
    val draftID: String,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    @SerialName("threadId")
    val threadID: String
)

@Serializable
data class EventScope (
    @SerialName("itemId")
    val itemID: String? = null,

    @SerialName("projectId")
    val projectID: String? = null,

    @SerialName("threadId")
    val threadID: String? = null,

    @SerialName("turnId")
    val turnID: String? = null
)

@Serializable
data class EventEnvelope (
    @Required
    val epoch: String,

    val impact: String? = null,

    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    val kind: String,

    @Required
    val payload: JsonElement?,

    @Required
    val scope: ScopeClass,

    @Required
    val seq: Long
)

@Serializable
data class ScopeClass (
    @SerialName("itemId")
    val itemID: String? = null,

    @SerialName("projectId")
    val projectID: String? = null,

    @SerialName("threadId")
    val threadID: String? = null,

    @SerialName("turnId")
    val turnID: String? = null
)

@Serializable
data class EventResume (
    @Required
    val afterSeq: Long,

    @Required
    val epoch: String,

    @Required
    val type: EventResumeType
)

@Serializable
enum class EventResumeType(val value: String) {
    @SerialName("resume") Resume("resume");
}

@Serializable
data class EventConnection (
    @Required
    val epoch: String,

    @Required
    val headSeq: Long,

    @Required
    @SerialName("installationId")
    val installationID: String,

    @Required
    val resetRequired: Boolean,

    @Required
    val type: EventConnectionType
)

@Serializable
enum class EventConnectionType(val value: String) {
    @SerialName("connection") Connection("connection");
}

@Serializable
data class EventHeartbeat (
    @Required
    val type: EventHeartbeatType
)

@Serializable
enum class EventHeartbeatType(val value: String) {
    @SerialName("ping") Ping("ping");
}

@Serializable
data class EventPong (
    @Required
    val epoch: String,

    @Required
    val type: EventPongType
)

@Serializable
enum class EventPongType(val value: String) {
    @SerialName("pong") Pong("pong");
}

@Serializable
data class ItemDelta (
    @Required
    val delta: String,

    val offset: Long? = null
)

@Serializable
data class ItemCompleted (
    @Required
    val complete: Boolean,

    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    @SerialName("completedAtMs")
    val completedAtMS: Long? = null,

    @Required
    val item: ItemCompletedItem,

    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    @SerialName("startedAtMs")
    val startedAtMS: Long? = null
)

@Serializable
data class ItemCompletedItem (
    val data: JsonElement? = null,
    val detailsAvailable: Boolean? = null,

    @Required
    val id: String,

    val text: String? = null,
    val truncated: Boolean? = null,

    @Required
    val type: String
)

@Serializable
data class HistoryInvalidated (
    val detailsAvailable: Boolean? = null,
    val historyRevision: String? = null,
    val originalKind: String? = null,

    @Required
    val reasonCode: String,

    val truncated: Boolean? = null
)

@Serializable
data class ProjectChanged (
    @Required
    val project: ProjectChangedProject
)

@Serializable
data class ProjectChangedProject (
    @Required
    val available: Boolean,

    @Required
    val canonicalPath: String,

    @Required
    val id: String,

    @Required
    val name: String,

    @Required
    @SerialName("rootId")
    val rootID: String
)

@Serializable
data class ConnectionChanged (
    val reasonCode: String? = null,

    @Required
    val state: ConnectionStateEnum
)

@Serializable
data class OperationQueryResult (
    val attachment: AttachmentClass? = null,
    val delivery: Delivery? = null,
    val errorCode: String? = null,

    @SerialName("nativeThreadId")
    val nativeThreadID: String? = null,

    @SerialName("nativeTurnId")
    val nativeTurnID: String? = null,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    val status: OperationReceiptStatus
)

@Serializable
data class AttachmentClass (
    val digest: String? = null,

    @Required
    @SerialName("draftId")
    val draftID: String,

    @Required
    val expiresAt: Long? = null,

    @Required
    val id: String,

    @Required
    val kind: AttachmentKind,

    @Required
    val mime: String,

    @Required
    val name: String,

    @SerialName("operationId")
    val operationID: String? = null,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    val size: Long,

    @Required
    val state: AttachmentState,

    @Required
    @SerialName("threadId")
    val threadID: String
)

@Serializable
data class NativeStateEvent (
    @Required
    val data: JsonObject,

    @Required
    val method: String,

    @Required
    val truncated: Boolean
)

@Serializable
data class Model (
    val description: String? = null,

    @Required
    val displayName: String,

    @Required
    val id: String,

    val isDefault: Boolean? = null,

    @Required
    val model: String,

    @Required
    val supportedReasoningEfforts: List<ModelSupportedReasoningEffort>
)

@Serializable
data class ModelSupportedReasoningEffort (
    val description: String? = null,

    @Required
    val reasoningEffort: String
)

@Serializable
data class ModelPage (
    @Required
    val data: List<DatumElement>,

    @Required
    val nextCursor: String? = null
)

@Serializable
data class DatumElement (
    val description: String? = null,

    @Required
    val displayName: String,

    @Required
    val id: String,

    val isDefault: Boolean? = null,

    @Required
    val model: String,

    @Required
    val supportedReasoningEfforts: List<DatumSupportedReasoningEffort>
)

@Serializable
data class DatumSupportedReasoningEffort (
    val description: String? = null,

    @Required
    val reasoningEffort: String
)

@Serializable
data class ItemDetailsRequest (
    val cursor: String? = null,

    @Required
    @SerialName("itemId")
    val itemID: String,

    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    @SerialName("turnId")
    val turnID: String
)

@Serializable
data class ItemDetails (
    @Required
    val chunk: String,

    @Required
    val complete: Boolean,

    @Required
    val encoding: Encoding,

    @Required
    val epoch: String,

    @Required
    val format: Format,

    @Required
    val historyRevision: String,

    @Required
    @SerialName("itemId")
    val itemID: String,

    @Required
    val nextCursor: String? = null,

    @Required
    val offsetBytes: Long,

    @Required
    val sha256: String,

    @Required
    val source: HistoryPageSource,

    @Required
    val totalBytes: Long
)

@Serializable
enum class Encoding(val value: String) {
    @SerialName("base64") Base64("base64");
}

@Serializable
enum class Format(val value: String) {
    @SerialName("native-item-json") NativeItemJSON("native-item-json");
}

@Serializable
data class PermissionReadback (
    @Required
    val approvalPolicy: String,

    @Required
    val observedAt: Long,

    @Required
    val preset: Preset? = null,

    @Required
    val sandboxType: String,

    @Required
    val source: PermissionReadbackSource
)

@Serializable
data class ExtensionEntry (
    val callable: Boolean? = null,
    val description: String? = null,
    val enabled: Boolean? = null,

    @Required
    val id: String,

    @Required
    val name: String,

    val resourceCount: Long? = null,
    val source: String? = null,
    val status: String? = null,
    val toolCount: Long? = null,
    val version: String? = null
)

@Serializable
data class ExtensionSection (
    @Required
    val entries: List<ExtensionSectionEntry>,

    @Required
    val kind: ExtensionSectionKind,

    @Required
    val limited: Boolean,

    val reasonCode: String? = null,

    @Required
    val status: ExtensionSectionStatus
)

@Serializable
data class ExtensionSectionEntry (
    val callable: Boolean? = null,
    val description: String? = null,
    val enabled: Boolean? = null,

    @Required
    val id: String,

    @Required
    val name: String,

    val resourceCount: Long? = null,
    val source: String? = null,
    val status: String? = null,
    val toolCount: Long? = null,
    val version: String? = null
)

@Serializable
enum class ExtensionSectionKind(val value: String) {
    @SerialName("apps") Apps("apps"),
    @SerialName("mcp") MCP("mcp"),
    @SerialName("plugins") Plugins("plugins"),
    @SerialName("skills") Skills("skills");
}

@Serializable
enum class ExtensionSectionStatus(val value: String) {
    @SerialName("available") Available("available"),
    @SerialName("unavailable") Unavailable("unavailable");
}

@Serializable
data class ExtensionsSnapshot (
    @Required
    @SerialName("projectId")
    val projectID: String,

    @Required
    val sections: List<SectionElement>
)

@Serializable
data class SectionElement (
    @Required
    val entries: List<SectionEntry>,

    @Required
    val kind: ExtensionSectionKind,

    @Required
    val limited: Boolean,

    val reasonCode: String? = null,

    @Required
    val status: ExtensionSectionStatus
)

@Serializable
data class SectionEntry (
    val callable: Boolean? = null,
    val description: String? = null,
    val enabled: Boolean? = null,

    @Required
    val id: String,

    @Required
    val name: String,

    val resourceCount: Long? = null,
    val source: String? = null,
    val status: String? = null,
    val toolCount: Long? = null,
    val version: String? = null
)

@Serializable
data class ThreadMutationRequest (
    @Required
    val expectedEpoch: String,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class ThreadDeleteRequest (
    @Required
    val confirm: Boolean,

    @Required
    val expectedEpoch: String,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class ThreadNameRequest (
    @Required
    val expectedEpoch: String,

    @Required
    val name: String,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class ThreadForkRequest (
    @Required
    val expectedEpoch: String,

    @SerialName("lastTurnId")
    val lastTurnID: String? = null,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class ThreadRevertRequest (
    @Required
    @SerialName("beforeTurnId")
    val beforeTurnID: String,

    @Required
    val expectedEpoch: String,

    @Required
    @SerialName("operationId")
    val operationID: String,

    @Required
    @SerialName("projectId")
    val projectID: String
)

@Serializable
data class NativeDefaults (
    @Required
    val approvalPolicy: ApprovalPolicy? = null,

    @Required
    val effort: String? = null,

    @Required
    val model: String? = null,

    @Required
    val origins: Origins,

    @Required
    val readAt: Long,

    @Required
    val sandboxMode: SandboxMode? = null,

    @Required
    val source: NativeDefaultsSource,

    @Required
    val workspaceWriteNetworkAccess: Boolean? = null
)

@Serializable
enum class ApprovalPolicy(val value: String) {
    @SerialName("custom") Custom("custom"),
    @SerialName("never") Never("never"),
    @SerialName("on-failure") OnFailure("on-failure"),
    @SerialName("on-request") OnRequest("on-request"),
    @SerialName("untrusted") Untrusted("untrusted");
}

@Serializable
data class Origins (
    val approvalPolicy: EffortEnum? = null,
    val effort: EffortEnum? = null,
    val model: EffortEnum? = null,
    val sandboxMode: EffortEnum? = null,
    val workspaceWriteNetworkAccess: EffortEnum? = null
)

@Serializable
enum class EffortEnum(val value: String) {
    @SerialName("system") ApprovalPolicySystem("system"),
    @SerialName("enterpriseManaged") EnterpriseManaged("enterpriseManaged"),
    @SerialName("legacyManagedConfigTomlFromFile") LegacyManagedConfigTomlFromFile("legacyManagedConfigTomlFromFile"),
    @SerialName("legacyManagedConfigTomlFromMdm") LegacyManagedConfigTomlFromMdm("legacyManagedConfigTomlFromMdm"),
    @SerialName("mdm") Mdm("mdm"),
    @SerialName("packagedDefaults") PackagedDefaults("packagedDefaults"),
    @SerialName("project") Project("project"),
    @SerialName("sessionFlags") SessionFlags("sessionFlags"),
    @SerialName("user") User("user");
}

@Serializable
enum class SandboxMode(val value: String) {
    @SerialName("danger-full-access") DangerFullAccess("danger-full-access"),
    @SerialName("read-only") ReadOnly("read-only"),
    @SerialName("workspace-write") WorkspaceWrite("workspace-write");
}

@Serializable
enum class NativeDefaultsSource(val value: String) {
    @SerialName("native-config") NativeConfig("native-config");
}

@Serializable
data class RateLimitWindow (
    @Required
    val resetsAt: Long? = null,

    @Required
    val usedPercent: Long,

    @Required
    val windowDurationMins: Long? = null
)

@Serializable
data class RateLimitCredits (
    @Required
    val balance: String? = null,

    @Required
    val hasCredits: Boolean,

    @Required
    val unlimited: Boolean
)

@Serializable
data class RateLimitIndividual (
    @Required
    val limit: String,

    @Required
    val remainingPercent: Long,

    @Required
    val resetsAt: Long,

    @Required
    val used: String
)

@Serializable
data class RateLimitSnapshot (
    @Required
    val credits: RateLimitSnapshotRateLimitCredits? = null,

    @Required
    val individualLimit: RateLimitSnapshotRateLimitIndividual? = null,

    @Required
    @SerialName("limitId")
    val limitID: String? = null,

    @Required
    val limitName: String? = null,

    @Required
    val planType: String? = null,

    @Required
    val primary: RateLimitSnapshotRateLimitWindow? = null,

    @Required
    val rateLimitReachedType: String? = null,

    @Required
    val secondary: RateLimitSnapshotRateLimitWindow? = null,

    @Required
    val spendControlReached: Boolean? = null
)

@Serializable
data class RateLimitSnapshotRateLimitCredits (
    @Required
    val balance: String? = null,

    @Required
    val hasCredits: Boolean,

    @Required
    val unlimited: Boolean
)

@Serializable
data class RateLimitSnapshotRateLimitIndividual (
    @Required
    val limit: String,

    @Required
    val remainingPercent: Long,

    @Required
    val resetsAt: Long,

    @Required
    val used: String
)

@Serializable
data class RateLimitSnapshotRateLimitWindow (
    @Required
    val resetsAt: Long? = null,

    @Required
    val usedPercent: Long,

    @Required
    val windowDurationMins: Long? = null
)

@Serializable
data class AccountRateLimits (
    @Required
    val limited: Boolean,

    @Required
    val ordinaryUsageAllowed: Boolean? = null,

    @Required
    val rateLimits: RateLimitsClass,

    @Required
    @SerialName("rateLimitsByLimitId")
    val rateLimitsByLimitID: Map<String, RateLimitsClass>? = null,

    @Required
    val readAt: Long,

    @Required
    val resetCreditsAvailable: Long? = null,

    @Required
    val source: AccountRateLimitsSource
)

@Serializable
data class RateLimitsClass (
    @Required
    val credits: RateLimitsRateLimitCredits? = null,

    @Required
    val individualLimit: RateLimitsRateLimitIndividual? = null,

    @Required
    @SerialName("limitId")
    val limitID: String? = null,

    @Required
    val limitName: String? = null,

    @Required
    val planType: String? = null,

    @Required
    val primary: RateLimitsRateLimitWindow? = null,

    @Required
    val rateLimitReachedType: String? = null,

    @Required
    val secondary: RateLimitsRateLimitWindow? = null,

    @Required
    val spendControlReached: Boolean? = null
)

@Serializable
data class RateLimitsRateLimitCredits (
    @Required
    val balance: String? = null,

    @Required
    val hasCredits: Boolean,

    @Required
    val unlimited: Boolean
)

@Serializable
data class RateLimitsRateLimitIndividual (
    @Required
    val limit: String,

    @Required
    val remainingPercent: Long,

    @Required
    val resetsAt: Long,

    @Required
    val used: String
)

@Serializable
data class RateLimitsRateLimitWindow (
    @Required
    val resetsAt: Long? = null,

    @Required
    val usedPercent: Long,

    @Required
    val windowDurationMins: Long? = null
)

@Serializable
enum class AccountRateLimitsSource(val value: String) {
    @SerialName("native-rate-limits") NativeRateLimits("native-rate-limits");
}

@Serializable
data class AccountUsageSummary (
    @Required
    val currentStreakDays: Long? = null,

    @Required
    val lifetimeTokens: Long? = null,

    @Required
    @SerialName("longestRunningTurnSec")
    val longestRunningTurnSEC: Long? = null,

    @Required
    val longestStreakDays: Long? = null,

    @Required
    val peakDailyTokens: Long? = null
)

@Serializable
data class AccountDailyUsageBucket (
    @Required
    val startDate: String,

    @Required
    val tokens: Long
)

@Serializable
data class AccountUsage (
    @Required
    val dailyUsageBuckets: List<DailyUsageBucketElement>? = null,

    @Required
    val limited: Boolean,

    @Required
    val readAt: Long,

    @Required
    val source: AccountUsageSource,

    @Required
    val summary: SummaryClass
)

@Serializable
data class DailyUsageBucketElement (
    @Required
    val startDate: String,

    @Required
    val tokens: Long
)

@Serializable
enum class AccountUsageSource(val value: String) {
    @SerialName("native-account-usage") NativeAccountUsage("native-account-usage");
}

@Serializable
data class SummaryClass (
    @Required
    val currentStreakDays: Long? = null,

    @Required
    val lifetimeTokens: Long? = null,

    @Required
    @SerialName("longestRunningTurnSec")
    val longestRunningTurnSEC: Long? = null,

    @Required
    val longestStreakDays: Long? = null,

    @Required
    val peakDailyTokens: Long? = null
)
