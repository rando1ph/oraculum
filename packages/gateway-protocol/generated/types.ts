// Generated from schema/v2.json by quicktype-core 24.0.0; DO NOT EDIT.
// Schema SHA-256: e30983d4bee805f0ebeff389e480d790a30fd964b27cf2a447f07cc4bf4713eb
export interface ProtocolVersion {
    major:          number;
    minClientMinor: number;
    minor:          number;
    [property: string]: unknown;
}

export interface HealthResponse {
    installationId: string;
    protocolMajor:  number;
    status:         "ok";
    [property: string]: unknown;
}

export interface GatewayError {
    code:          string;
    delivery?:     Delivery;
    message:       string;
    operationId?:  string;
    reset?:        boolean;
    retryAfterMs?: number;
    [property: string]: unknown;
}

export type Delivery = "notSent" | "sent" | "unknown";

export interface ErrorResponse {
    epoch:          string;
    error:          ErrorObject;
    installationId: string;
    requestId:      string;
    [property: string]: unknown;
}

export interface ErrorObject {
    code:          string;
    delivery?:     Delivery;
    message:       string;
    operationId?:  string;
    reset?:        boolean;
    retryAfterMs?: number;
    [property: string]: unknown;
}

export interface OperationReceipt {
    delivery?:       Delivery;
    errorCode?:      string;
    nativeThreadId?: string;
    nativeTurnId?:   string;
    operationId:     string;
    status:          OperationReceiptStatus;
    [property: string]: unknown;
}

export type OperationReceiptStatus = "accepted" | "rejected" | "unknown";

export interface OperationResponse {
    epoch:          string;
    installationId: string;
    operation:      OperationResponseOperation;
    requestId:      string;
    [property: string]: unknown;
}

export interface OperationResponseOperation {
    delivery?:       Delivery;
    errorCode?:      string;
    nativeThreadId?: string;
    nativeTurnId?:   string;
    operationId:     string;
    status:          OperationReceiptStatus;
    [property: string]: unknown;
}

export interface ResourceResponse {
    data:           unknown;
    epoch:          string;
    installationId: string;
    requestId:      string;
    [property: string]: unknown;
}

export interface Capability {
    availability:    Availability;
    epoch:           string;
    maturity:        Maturity;
    name:            string;
    observedVersion: null | string;
    reasonCode:      null | string;
    supported:       boolean;
    verified:        boolean;
    [property: string]: unknown;
}

export type Availability = "unverified" | "available" | "unavailable" | "unsupported";

export type Maturity = "gateway" | "default-surface" | "experimental" | "under-development" | "deprecated";

export interface Capabilities {
    capabilities:   CapabilityElement[];
    codex:          Codex;
    epoch:          string;
    gatewayVersion: string;
    installationId: string;
    limits:         Limits;
    protocol:       ProtocolObject;
    [property: string]: unknown;
}

export interface CapabilityElement {
    availability:    Availability;
    epoch:           string;
    maturity:        Maturity;
    name:            string;
    observedVersion: null | string;
    reasonCode:      null | string;
    supported:       boolean;
    verified:        boolean;
    [property: string]: unknown;
}

export interface Codex {
    connectionState: ConnectionStateEnum;
    version:         null | string;
    [property: string]: unknown;
}

export type ConnectionStateEnum = "connected" | "disconnected" | "connecting";

export interface Limits {
    attachmentBatchBytes: number;
    attachmentBatchCount: number;
    attachmentFileBytes:  number;
    eventReplayCount:     number;
    historyPageItems:     number;
    requestBytes:         number;
    [property: string]: unknown;
}

export interface ProtocolObject {
    major:          number;
    minClientMinor: number;
    minor:          number;
    [property: string]: unknown;
}

export interface PairRequest {
    code:             string;
    deviceCredential: string;
    deviceId:         string;
    installationId:   string;
    label:            string;
}

export interface TokenRequest {
    deviceCredential: string;
    deviceId:         string;
    installationId:   string;
}

export interface AuthResponse {
    accessToken:    string;
    deviceId:       string;
    expiresAt:      number;
    installationId: string;
    [property: string]: unknown;
}

export interface SessionResponse {
    createdAt:      number;
    deviceId:       string;
    expiresAt:      number;
    installationId: string;
    label:          string;
    [property: string]: unknown;
}

export interface LogoutRequest {
    operationId: string;
}

export interface Root {
    id:    string;
    label: string;
    [property: string]: unknown;
}

export interface Project {
    available:     boolean;
    canonicalPath: string;
    id:            string;
    name:          string;
    rootId:        string;
    [property: string]: unknown;
}

export interface Projects {
    projects: ProjectElement[];
    roots:    RootElement[];
    [property: string]: unknown;
}

export interface ProjectElement {
    available:     boolean;
    canonicalPath: string;
    id:            string;
    name:          string;
    rootId:        string;
    [property: string]: unknown;
}

export interface RootElement {
    id:    string;
    label: string;
    [property: string]: unknown;
}

export interface DirectoryQuery {
    cursor?: null | string;
    limit?:  number;
    path?:   string;
    rootId:  string;
}

export interface DirectoryEntry {
    name: string;
    path: string;
    [property: string]: unknown;
}

export interface DirectoryPage {
    canRegister: boolean;
    entries:     EntryElement[];
    limited:     boolean;
    nextCursor:  null | string;
    path:        string;
    rootId:      string;
    [property: string]: unknown;
}

export interface EntryElement {
    name: string;
    path: string;
    [property: string]: unknown;
}

export interface ProjectRegisterRequest {
    operationId: string;
    path:        string;
    rootId:      string;
}

export interface ProjectUnregisterRequest {
    operationId: string;
}

export interface ThreadStartRequest {
    effort?:           string;
    expectedEpoch:     string;
    model?:            string;
    operationId:       string;
    permissionPreset?: Preset;
}

export type Preset = "read-only" | "auto" | "full-access";

export interface ThreadResumeRequest {
    expectedEpoch: string;
    operationId:   string;
    projectId:     string;
}

export interface ThreadQuery {
    archived?: boolean;
    cursor?:   string;
    limit?:    number;
    search?:   string;
}

export interface Thread {
    archived?:           boolean;
    createdAt?:          number | null;
    id:                  string;
    model?:              null | string;
    parentThreadId?:     null | string;
    permissionPreset?:   null | string;
    permissionReadback?: ThreadPermissionReadback;
    preview?:            string;
    projectId:           string;
    reasoningEffort?:    null | string;
    status:              string;
    title?:              null | string;
    updatedAt?:          number | null;
    [property: string]: unknown;
}

export interface ThreadPermissionReadback {
    approvalPolicy: string;
    observedAt:     number;
    preset:         Preset | null;
    sandboxType:    string;
    source:         PermissionReadbackSource;
    [property: string]: unknown;
}

export type PermissionReadbackSource = "thread.start" | "thread.resume";

export interface ThreadPage {
    nextCursor: null | string;
    source:     string;
    threads:    ThreadElement[];
    truncated:  boolean;
    [property: string]: unknown;
}

export interface ThreadElement {
    archived?:           boolean;
    createdAt?:          number | null;
    id:                  string;
    model?:              null | string;
    parentThreadId?:     null | string;
    permissionPreset?:   null | string;
    permissionReadback?: PurplePermissionReadback;
    preview?:            string;
    projectId:           string;
    reasoningEffort?:    null | string;
    status:              string;
    title?:              null | string;
    updatedAt?:          number | null;
    [property: string]: unknown;
}

export interface PurplePermissionReadback {
    approvalPolicy: string;
    observedAt:     number;
    preset:         Preset | null;
    sandboxType:    string;
    source:         PermissionReadbackSource;
    [property: string]: unknown;
}

export interface TextInput {
    text: string;
    type: "text";
}

export interface TurnStartRequest {
    attachmentIds?:    string[];
    draftId?:          string;
    effort?:           string;
    expectedEpoch:     string;
    input:             TurnStartRequestInput[];
    model?:            string;
    operationId:       string;
    permissionPreset?: Preset;
    projectId:         string;
}

export interface TurnStartRequestInput {
    text: string;
    type: "text";
}

export interface TurnInterruptRequest {
    expectedEpoch: string;
    operationId:   string;
    projectId:     string;
}

export interface TurnSteerRequest {
    expectedEpoch: string;
    input:         TurnSteerRequestInput[];
    operationId:   string;
    projectId:     string;
}

export interface TurnSteerRequestInput {
    text: string;
    type: "text";
}

export interface Turn {
    error?:    null | GatewayErrorObject;
    id:        string;
    items?:    ItemElement[];
    status:    string;
    threadId?: string;
    [property: string]: unknown;
}

export interface GatewayErrorObject {
    code:          string;
    delivery?:     Delivery;
    message:       string;
    operationId?:  string;
    reset?:        boolean;
    retryAfterMs?: number;
    [property: string]: unknown;
}

export interface ItemElement {
    data?:             unknown;
    detailsAvailable?: boolean;
    id:                string;
    text?:             string;
    truncated?:        boolean;
    type:              string;
    [property: string]: unknown;
}

export interface NativeItem {
    data?:             unknown;
    detailsAvailable?: boolean;
    id:                string;
    text?:             string;
    truncated?:        boolean;
    type:              string;
    [property: string]: unknown;
}

export interface HistoryQuery {
    cursor?:   null | string;
    limit?:    number;
    projectId: string;
    turnId?:   string;
}

export interface HistoryPage {
    complete:        boolean;
    epoch:           string;
    historyRevision: string;
    itemCursors?:    { [key: string]: string };
    /**
     * Optional native producer timing by native Item ID. Full-read fallback may omit it.
     */
    itemTimings?: { [key: string]: HistoryPageItemTiming };
    items:        unknown[];
    nextCursor:   null | string;
    source:       HistoryPageSource;
    truncated:    boolean;
    [property: string]: unknown;
}

export interface HistoryPageItemTiming {
    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    completedAtMs?: number;
    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    startedAtMs?: number;
}

export type HistoryPageSource = "native-pagination" | "native-read-projection";

export interface SnapshotRequest {
    knownEpoch?:    string;
    knownRevision?: string;
    projectId:      string;
}

export interface Snapshot {
    epoch:            string;
    history:          HistoryObject;
    interactions:     InteractionElement[];
    observedEndSeq:   number;
    observedStartSeq: number;
    operations:       OperationElement[];
    synchronization:  Synchronization;
    thread:           SnapshotThread;
    [property: string]: unknown;
}

export interface HistoryObject {
    complete:        boolean;
    epoch:           string;
    historyRevision: string;
    itemCursors?:    { [key: string]: string };
    /**
     * Optional native producer timing by native Item ID. Full-read fallback may omit it.
     */
    itemTimings?: { [key: string]: HistoryItemTiming };
    items:        unknown[];
    nextCursor:   null | string;
    source:       HistoryPageSource;
    truncated:    boolean;
    [property: string]: unknown;
}

export interface HistoryItemTiming {
    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    completedAtMs?: number;
    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    startedAtMs?: number;
}

export interface InteractionElement {
    epoch:         string;
    generation:    number;
    interactionId: string;
    kind:          string;
    projectId:     string;
    request:       { [key: string]: unknown };
    status:        InteractionStatus;
    threadId:      string;
    turnId:        null | string;
    [property: string]: unknown;
}

export type InteractionStatus = "pending" | "submitted" | "unknown" | "resolved";

export interface OperationElement {
    delivery?:       Delivery;
    errorCode?:      string;
    nativeThreadId?: string;
    nativeTurnId?:   string;
    operationId:     string;
    status:          OperationReceiptStatus;
    [property: string]: unknown;
}

export type Synchronization = "synchronizing" | "current" | "stale";

export interface SnapshotThread {
    archived?:           boolean;
    createdAt?:          number | null;
    id:                  string;
    model?:              null | string;
    parentThreadId?:     null | string;
    permissionPreset?:   null | string;
    permissionReadback?: FluffyPermissionReadback;
    preview?:            string;
    projectId:           string;
    reasoningEffort?:    null | string;
    status:              string;
    title?:              null | string;
    updatedAt?:          number | null;
    [property: string]: unknown;
}

export interface FluffyPermissionReadback {
    approvalPolicy: string;
    observedAt:     number;
    preset:         Preset | null;
    sandboxType:    string;
    source:         PermissionReadbackSource;
    [property: string]: unknown;
}

export interface ApprovalResponse {
    decision: Ion;
    type:     "approval";
}

export type Ion = "accept" | "decline" | "cancel";

export interface InputResponse {
    answers: { [key: string]: string[] };
    type:    "input";
}

export interface ElicitationResponse {
    action:   Ion;
    content?: { [key: string]: unknown } | null;
    type:     "elicitation";
}

export interface InteractionResponseRequest {
    epoch:       string;
    generation:  number;
    operationId: string;
    projectId:   string;
    response:    InteractionAnswer;
}

export interface InteractionAnswer {
    action?:   Ion;
    answers?:  { [key: string]: string[] };
    content?:  { [key: string]: unknown } | null;
    decision?: Ion;
    type:      InteractionAnswerType;
}

export type InteractionAnswerType = "approval" | "input" | "elicitation";

export interface Interaction {
    epoch:         string;
    generation:    number;
    interactionId: string;
    kind:          string;
    projectId:     string;
    request:       { [key: string]: unknown };
    status:        InteractionStatus;
    threadId:      string;
    turnId:        null | string;
    [property: string]: unknown;
}

export interface FilesQuery {
    cursor?: null | string;
    limit?:  number;
    path?:   string;
}

export interface FileEntry {
    directory: boolean;
    mime:      string;
    name:      string;
    path:      string;
    size:      number;
    [property: string]: unknown;
}

export interface FilePage {
    entries:    EntryObject[];
    limited:    boolean;
    nextCursor: null | string;
    path:       string;
    [property: string]: unknown;
}

export interface EntryObject {
    directory: boolean;
    mime:      string;
    name:      string;
    path:      string;
    size:      number;
    [property: string]: unknown;
}

export interface FileSelectRequest {
    path:      string;
    threadId?: string;
}

export interface FileGrant {
    expiresAt: number;
    fileId:    string;
    mime:      string;
    name:      string;
    path:      string;
    projectId: string;
    size:      number;
    threadId?: null | string;
    [property: string]: unknown;
}

export interface AttachmentUploadMetadata {
    draftId:     string;
    mime:        string;
    name:        string;
    operationId: string;
    projectId:   string;
    size:        number;
    threadId:    string;
}

export interface Attachment {
    digest?:      string;
    draftId:      string;
    expiresAt:    number | null;
    id:           string;
    kind:         AttachmentKind;
    mime:         string;
    name:         string;
    operationId?: null | string;
    projectId:    string;
    size:         number;
    state:        AttachmentState;
    threadId:     string;
    [property: string]: unknown;
}

export type AttachmentKind = "image" | "document";

export type AttachmentState = "uploading" | "ready" | "held" | "sent" | "expired" | "unknown";

export interface AttachmentDeleteRequest {
    draftId:     string;
    operationId: string;
    projectId:   string;
    threadId:    string;
}

export interface EventScope {
    itemId?:    string;
    projectId?: string;
    threadId?:  string;
    turnId?:    string;
}

export interface EventEnvelope {
    epoch:          string;
    impact?:        string;
    installationId: string;
    kind:           string;
    payload:        unknown;
    scope:          ScopeClass;
    seq:            number;
    [property: string]: unknown;
}

export interface ScopeClass {
    itemId?:    string;
    projectId?: string;
    threadId?:  string;
    turnId?:    string;
}

export interface EventResume {
    afterSeq: number;
    epoch:    string;
    type:     "resume";
}

export interface EventConnection {
    epoch:          string;
    headSeq:        number;
    installationId: string;
    resetRequired:  boolean;
    type:           "connection";
    [property: string]: unknown;
}

export interface EventHeartbeat {
    type: "ping";
}

export interface EventPong {
    epoch: string;
    type:  "pong";
    [property: string]: unknown;
}

export interface ItemDelta {
    delta:   string;
    offset?: number;
    [property: string]: unknown;
}

export interface ItemCompleted {
    complete: boolean;
    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    completedAtMs?: number;
    item:           ItemCompletedItem;
    /**
     * Native producer Unix timestamp in milliseconds; omitted when unavailable.
     */
    startedAtMs?: number;
    [property: string]: unknown;
}

export interface ItemCompletedItem {
    data?:             unknown;
    detailsAvailable?: boolean;
    id:                string;
    text?:             string;
    truncated?:        boolean;
    type:              string;
    [property: string]: unknown;
}

export interface HistoryInvalidated {
    detailsAvailable?: boolean;
    historyRevision?:  string;
    originalKind?:     string;
    reasonCode:        string;
    truncated?:        boolean;
    [property: string]: unknown;
}

export interface ProjectChanged {
    project: ProjectChangedProject;
    [property: string]: unknown;
}

export interface ProjectChangedProject {
    available:     boolean;
    canonicalPath: string;
    id:            string;
    name:          string;
    rootId:        string;
    [property: string]: unknown;
}

export interface ConnectionChanged {
    reasonCode?: string;
    state:       ConnectionStateEnum;
    [property: string]: unknown;
}

export interface OperationQueryResult {
    attachment?:     AttachmentObject;
    delivery?:       Delivery;
    errorCode?:      string;
    nativeThreadId?: string;
    nativeTurnId?:   string;
    operationId:     string;
    status:          OperationReceiptStatus;
    [property: string]: unknown;
}

export interface AttachmentObject {
    digest?:      string;
    draftId:      string;
    expiresAt:    number | null;
    id:           string;
    kind:         AttachmentKind;
    mime:         string;
    name:         string;
    operationId?: null | string;
    projectId:    string;
    size:         number;
    state:        AttachmentState;
    threadId:     string;
    [property: string]: unknown;
}

export interface NativeStateEvent {
    data:      { [key: string]: unknown };
    method:    string;
    truncated: boolean;
    [property: string]: unknown;
}

export interface Model {
    description?:              string;
    displayName:               string;
    id:                        string;
    isDefault?:                boolean;
    model:                     string;
    supportedReasoningEfforts: ModelSupportedReasoningEffort[];
    [property: string]: unknown;
}

export interface ModelSupportedReasoningEffort {
    description?:    string;
    reasoningEffort: string;
    [property: string]: unknown;
}

export interface ModelPage {
    data:       DatumElement[];
    nextCursor: null | string;
    [property: string]: unknown;
}

export interface DatumElement {
    description?:              string;
    displayName:               string;
    id:                        string;
    isDefault?:                boolean;
    model:                     string;
    supportedReasoningEfforts: DatumSupportedReasoningEffort[];
    [property: string]: unknown;
}

export interface DatumSupportedReasoningEffort {
    description?:    string;
    reasoningEffort: string;
    [property: string]: unknown;
}

export interface ItemDetailsRequest {
    cursor?:   null | string;
    itemId:    string;
    projectId: string;
    turnId:    string;
}

export interface ItemDetails {
    chunk:           string;
    complete:        boolean;
    encoding:        "base64";
    epoch:           string;
    format:          "native-item-json";
    historyRevision: string;
    itemId:          string;
    nextCursor:      null | string;
    offsetBytes:     number;
    sha256:          string;
    source:          HistoryPageSource;
    totalBytes:      number;
    [property: string]: unknown;
}

export interface PermissionReadback {
    approvalPolicy: string;
    observedAt:     number;
    preset:         Preset | null;
    sandboxType:    string;
    source:         PermissionReadbackSource;
    [property: string]: unknown;
}

export interface ExtensionEntry {
    callable?:      boolean;
    description?:   string;
    enabled?:       boolean;
    id:             string;
    name:           string;
    resourceCount?: number;
    source?:        string;
    status?:        string;
    toolCount?:     number;
    version?:       string;
    [property: string]: unknown;
}

export interface ExtensionSection {
    entries:     ExtensionSectionEntry[];
    kind:        ExtensionSectionKind;
    limited:     boolean;
    reasonCode?: string;
    status:      ExtensionSectionStatus;
    [property: string]: unknown;
}

export interface ExtensionSectionEntry {
    callable?:      boolean;
    description?:   string;
    enabled?:       boolean;
    id:             string;
    name:           string;
    resourceCount?: number;
    source?:        string;
    status?:        string;
    toolCount?:     number;
    version?:       string;
    [property: string]: unknown;
}

export type ExtensionSectionKind = "skills" | "mcp" | "apps" | "plugins";

export type ExtensionSectionStatus = "available" | "unavailable";

export interface ExtensionsSnapshot {
    projectId: string;
    sections:  SectionElement[];
    [property: string]: unknown;
}

export interface SectionElement {
    entries:     SectionEntry[];
    kind:        ExtensionSectionKind;
    limited:     boolean;
    reasonCode?: string;
    status:      ExtensionSectionStatus;
    [property: string]: unknown;
}

export interface SectionEntry {
    callable?:      boolean;
    description?:   string;
    enabled?:       boolean;
    id:             string;
    name:           string;
    resourceCount?: number;
    source?:        string;
    status?:        string;
    toolCount?:     number;
    version?:       string;
    [property: string]: unknown;
}

export interface ThreadMutationRequest {
    expectedEpoch: string;
    operationId:   string;
    projectId:     string;
}

export interface ThreadDeleteRequest {
    confirm:       boolean;
    expectedEpoch: string;
    operationId:   string;
    projectId:     string;
}

export interface ThreadNameRequest {
    expectedEpoch: string;
    name:          string;
    operationId:   string;
    projectId:     string;
}

export interface ThreadForkRequest {
    expectedEpoch: string;
    lastTurnId?:   string;
    operationId:   string;
    projectId:     string;
}

export interface ThreadRevertRequest {
    beforeTurnId:  string;
    expectedEpoch: string;
    operationId:   string;
    projectId:     string;
}

export interface NativeDefaults {
    approvalPolicy:              ApprovalPolicy | null;
    effort:                      null | string;
    model:                       null | string;
    origins:                     Origins;
    readAt:                      number;
    sandboxMode:                 SandboxMode | null;
    source:                      "native-config";
    workspaceWriteNetworkAccess: boolean | null;
}

export type ApprovalPolicy = "untrusted" | "on-request" | "never" | "on-failure" | "custom";

export interface Origins {
    approvalPolicy?:              EffortEnum;
    effort?:                      EffortEnum;
    model?:                       EffortEnum;
    sandboxMode?:                 EffortEnum;
    workspaceWriteNetworkAccess?: EffortEnum;
}

export type EffortEnum = "packagedDefaults" | "mdm" | "system" | "enterpriseManaged" | "user" | "project" | "sessionFlags" | "legacyManagedConfigTomlFromFile" | "legacyManagedConfigTomlFromMdm";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface RateLimitWindow {
    resetsAt:           number | null;
    usedPercent:        number;
    windowDurationMins: number | null;
}

export interface RateLimitCredits {
    balance:    null | string;
    hasCredits: boolean;
    unlimited:  boolean;
}

export interface RateLimitIndividual {
    limit:            string;
    remainingPercent: number;
    resetsAt:         number;
    used:             string;
}

export interface RateLimitSnapshot {
    credits:              RateLimitSnapshotRateLimitCredits | null;
    individualLimit:      RateLimitSnapshotRateLimitIndividual | null;
    limitId:              null | string;
    limitName:            null | string;
    planType:             null | string;
    primary:              RateLimitSnapshotRateLimitWindow | null;
    rateLimitReachedType: null | string;
    secondary:            RateLimitSnapshotRateLimitWindow | null;
    spendControlReached:  boolean | null;
}

export interface RateLimitSnapshotRateLimitCredits {
    balance:    null | string;
    hasCredits: boolean;
    unlimited:  boolean;
}

export interface RateLimitSnapshotRateLimitIndividual {
    limit:            string;
    remainingPercent: number;
    resetsAt:         number;
    used:             string;
}

export interface RateLimitSnapshotRateLimitWindow {
    resetsAt:           number | null;
    usedPercent:        number;
    windowDurationMins: number | null;
}

export interface AccountRateLimits {
    limited:               boolean;
    ordinaryUsageAllowed:  boolean | null;
    rateLimits:            RateLimitsClass;
    rateLimitsByLimitId:   { [key: string]: RateLimitsClass } | null;
    readAt:                number;
    resetCreditsAvailable: number | null;
    source:                "native-rate-limits";
}

export interface RateLimitsClass {
    credits:              RateLimitsRateLimitCredits | null;
    individualLimit:      RateLimitsRateLimitIndividual | null;
    limitId:              null | string;
    limitName:            null | string;
    planType:             null | string;
    primary:              RateLimitsRateLimitWindow | null;
    rateLimitReachedType: null | string;
    secondary:            RateLimitsRateLimitWindow | null;
    spendControlReached:  boolean | null;
}

export interface RateLimitsRateLimitCredits {
    balance:    null | string;
    hasCredits: boolean;
    unlimited:  boolean;
}

export interface RateLimitsRateLimitIndividual {
    limit:            string;
    remainingPercent: number;
    resetsAt:         number;
    used:             string;
}

export interface RateLimitsRateLimitWindow {
    resetsAt:           number | null;
    usedPercent:        number;
    windowDurationMins: number | null;
}

export interface AccountUsageSummary {
    currentStreakDays:     number | null;
    lifetimeTokens:        number | null;
    longestRunningTurnSec: number | null;
    longestStreakDays:     number | null;
    peakDailyTokens:       number | null;
}

export interface AccountDailyUsageBucket {
    startDate: string;
    tokens:    number;
}

export interface AccountUsage {
    dailyUsageBuckets: DailyUsageBucketElement[] | null;
    limited:           boolean;
    readAt:            number;
    source:            "native-account-usage";
    summary:           SummaryClass;
}

export interface DailyUsageBucketElement {
    startDate: string;
    tokens:    number;
}

export interface SummaryClass {
    currentStreakDays:     number | null;
    lifetimeTokens:        number | null;
    longestRunningTurnSec: number | null;
    longestStreakDays:     number | null;
    peakDailyTokens:       number | null;
}
