import type { TaskClarification, ChatMessage } from "./chat/taskChat.js";

import type { AgentPactClient } from "./client.js";
import type { WebSocketOptions } from "./transport/websocket.js";
import type { ExternalSigner } from "./signer.js";
import type { TaskDetailsData, TaskListItem, AgentWalletOverview, GasQuoteRequest, GasQuoteSummary, PreflightCheckRequest, PreflightCheckResult, TokenBalanceInfo, TransactionReceiptSummary, TransactionStatusSummary } from "./types.js";

// 鈹€鈹€鈹€鈹€ Configuration Types 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** Minimal config for AgentPactAgent.create() */
export interface AgentCreateOptions {
    /** Agent's wallet private key (hex, with or without 0x prefix). Ignored if `signer` is provided. */
    privateKey?: string;
    /**
     * External signer for private key isolation.
     * When provided, `privateKey` is ignored — all signing is delegated
     * to this adapter (e.g. IPC to a vault process).
     */
    signer?: ExternalSigner;
    /** Platform API URL (default: DEFAULT_PLATFORM_URL) */
    platformUrl?: string;
    /** Override RPC URL (default: from /api/config) */
    rpcUrl?: string;
    /** Optional Envio GraphQL URL override */
    envioUrl?: string;
    /** JWT token (if already authenticated) */
    jwtToken?: string;
    /** WebSocket connection options */
    wsOptions?: WebSocketOptions;
    /**
     * Automatically call claimTask() on-chain when ASSIGNMENT_SIGNATURE is received.
     * Default: false, so agents can review confidential details before deciding.
     */
    autoClaimOnSignature?: boolean;
}

/** Full agent config (after auto-discovery) */
export interface AgentConfig {
    client: AgentPactClient;
    platformUrl: string;
    wsUrl: string;
    jwtToken: string;
    walletAddress: `0x${string}`;
    wsOptions?: WebSocketOptions;
    autoClaimOnSignature: boolean;
    /** External signer adapter (when private key is isolated) */
    signer?: ExternalSigner;
}

/** Task event data from WebSocket */
export interface TaskEvent {
    type: string;
    data: Record<string, unknown>;
    taskId?: string;
}

/** Assignment signature data from platform */
export interface AssignmentSignatureData {
    escrowId: bigint;
    nonce: bigint;
    expiredAt: bigint;
    signature: `0x${string}`;
    taskId: string;
}

export interface ProviderRegistrationData {
    id: string;
    userId: string;
    agentType: string;
    capabilities: string[];
}

export interface ProviderProfileData extends ProviderRegistrationData {
    headline?: string | null;
    bio?: string | null;
    capabilityTags?: string[];
    preferredCategories?: string[];
    portfolioLinks?: string[];
    verifiedCapabilityTags?: string[];
    primaryCategories?: string[];
    reputationScore?: number;
    creditScore?: number;
    creditLevel?: number;
    totalTasks?: number;
    completedTasks?: number;
    activeTasks?: number;
    createdAt?: string | Date;
    updatedAt?: string | Date;
    user?: {
        id: string;
        name?: string | null;
        avatarUrl?: string | null;
        walletAddress?: string;
    };
}

export interface ProviderProfileUpdate {
    agentType?: string;
    capabilities?: string[];
    headline?: string;
    bio?: string;
    capabilityTags?: string[];
    preferredCategories?: string[];
    portfolioLinks?: string[];
}

export type AgentNodeStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";
export type AgentNodeAutomationMode = "MANUAL" | "ASSISTED" | "AUTO";
export type WorkerHostKind = "OPENCLAW" | "CODEX" | "MCP" | "CUSTOM";
export type WorkerRunStatus =
    | "QUEUED"
    | "STARTING"
    | "RUNNING"
    | "WAITING_APPROVAL"
    | "SUCCEEDED"
    | "FAILED"
    | "CANCELLED";
export type ApprovalRequestKind =
    | "TASK_RESPONSE"
    | "DELIVERY_SUBMISSION"
    | "SIGNING_ACTION"
    | "PAYMENT_ACTION"
    | "TOOL_PERMISSION"
    | "STRATEGY_DECISION"
    | "CUSTOM";
export type ApprovalRequestStatus =
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "EXPIRED"
    | "CANCELLED";

export interface AgentNodeRegistrationData {
    displayName: string;
    slug?: string;
    description?: string;
    automationMode?: AgentNodeAutomationMode;
    headline?: string;
    capabilityTags?: string[];
    policy?: Record<string, unknown>;
    agentType?: string;
    capabilities?: string[];
    preferredCategories?: string[];
    portfolioLinks?: string[];
}

export interface AgentNodeUpdate extends Partial<AgentNodeRegistrationData> {
    status?: AgentNodeStatus;
}

export type NodeAction = "PAUSE_NODE" | "RESUME_NODE" | "SET_AUTOMATION_MODE";
export type WorkerRunAction = "CANCEL" | "MARK_FAILED" | "RETRY";
export type TaskAction = "NUDGE_REQUESTER" | "MARK_MANUAL_REVIEW" | "ADD_NOTE";

export interface NodeActionInput {
    action: NodeAction;
    automationMode?: AgentNodeAutomationMode;
    note?: string;
}

export interface AgentNodeData {
    id: string;
    ownerId: string;
    displayName: string;
    slug?: string | null;
    description?: string | null;
    status?: AgentNodeStatus;
    automationMode?: AgentNodeAutomationMode;
    headline?: string | null;
    capabilityTags?: string[];
    policy?: Record<string, unknown> | null;
    lastSeenAt?: string | Date | null;
    createdAt?: string | Date;
    updatedAt?: string | Date;
    owner?: {
        id: string;
        name?: string | null;
        avatarUrl?: string | null;
        walletAddress?: string;
    };
    providerProfile?: ProviderProfileData | null;
    stats?: {
        activeWorkerRuns: number;
        totalWorkerRuns: number;
        pendingApprovals: number;
    };
}

export interface WorkerRunCreateInput {
    taskId?: string;
    hostKind: WorkerHostKind;
    workerKey: string;
    displayName?: string;
    model?: string;
    status?: WorkerRunStatus;
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
}

export interface WorkerRunUpdateInput {
    status?: WorkerRunStatus;
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
}

export interface WorkerRunHeartbeatInput {
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
}

export interface ResolveStaleWorkerRunsInput {
    action: Exclude<WorkerRunAction, "RETRY">;
    taskId?: string;
    limit?: number;
    note?: string;
}

export interface ResolveStaleWorkerRunsResult {
    action: Exclude<WorkerRunAction, "RETRY">;
    resolvedCount: number;
    runs: WorkerRunData[];
}

export interface WorkerRunData {
    id: string;
    nodeId: string;
    taskId?: string | null;
    requestedByUserId?: string | null;
    hostKind: WorkerHostKind;
    workerKey: string;
    displayName?: string | null;
    model?: string | null;
    status: WorkerRunStatus;
    percent: number;
    currentStep?: string | null;
    summary?: string | null;
    metadata?: Record<string, unknown> | null;
    startedAt?: string | Date | null;
    completedAt?: string | Date | null;
    lastHeartbeatAt?: string | Date | null;
    createdAt?: string | Date;
    updatedAt?: string | Date;
    task?: {
        id: string;
        title?: string | null;
        status?: string | null;
    } | null;
}

export interface WorkerTaskSessionStartInput {
    taskId: string;
    hostKind: WorkerHostKind;
    workerKey: string;
    displayName?: string;
    model?: string;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    ensureNode?: Partial<AgentNodeRegistrationData>;
}

export interface WorkerTaskSessionStartResult {
    node: AgentNodeData;
    run: WorkerRunData;
    task: TaskDetailsData;
    brief: WorkerTaskExecutionBrief;
}

export interface WorkerTaskSessionResumeInput extends WorkerTaskSessionStartInput {
    createIfMissing?: boolean;
}

export interface WorkerTaskSessionResumeResult extends WorkerTaskSessionStartResult {
    reusedExistingRun: boolean;
}

export interface WorkerRunClaimTaskInput {
    runId: string;
    taskId: string;
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
}

export interface WorkerRunClaimTaskResult {
    txHash: string;
    run: WorkerRunData;
    task: TaskDetailsData;
}

export interface WorkerTaskExecutionBrief {
    task: TaskDetailsData;
    node: AgentNodeData;
    workerRuns: WorkerRunData[];
    pendingApprovals: ApprovalRequestData[];
    clarifications: TaskClarification[];
    unreadChatCount: number;
    recentMessages: ChatMessage[];
    suggestedNextActions: string[];
}

export interface WorkerTaskExecutionBriefOptions {
    taskId: string;
    messagesLimit?: number;
    workerRunsLimit?: number;
    approvalsLimit?: number;
}

export interface WorkerTaskSessionFinishInput {
    runId: string;
    taskId?: string;
    outcome: Extract<WorkerRunStatus, "SUCCEEDED" | "FAILED" | "CANCELLED">;
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    unwatchTask?: boolean;
}

export interface WorkerRunSubmitDeliveryInput {
    runId: string;
    taskId: string;
    escrowId: bigint;
    deliveryHash: string;
    content?: string;
    artifacts?: unknown;
    selfTestResults?: unknown;
    revisionChanges?: unknown;
    aiValidationResult?: string;
    isPass?: boolean;
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
}

export interface WorkerRunSubmitDeliveryResult {
    txHash: string;
    deliveryId: string;
    delivery: unknown;
    run: WorkerRunData;
}

export interface WorkerRunAbandonTaskInput {
    runId: string;
    taskId?: string;
    escrowId: bigint;
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    unwatchTask?: boolean;
}

export interface WorkerRunAbandonTaskResult {
    txHash: string;
    run: WorkerRunData;
}

export interface WorkerRunClaimAcceptanceTimeoutInput {
    runId: string;
    taskId?: string;
    escrowId: bigint;
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    unwatchTask?: boolean;
}

export interface WorkerRunClaimAcceptanceTimeoutResult {
    txHash: string;
    run: WorkerRunData;
}

export interface WorkerApprovalGateInput {
    runId: string;
    taskId: string;
    kind: ApprovalRequestKind;
    title: string;
    summary?: string;
    payload?: Record<string, unknown>;
    dueAt?: string;
    percent?: number;
    currentStep?: string;
    runSummary?: string;
    metadata?: Record<string, unknown>;
}

export interface WorkerApprovalGateResult {
    run: WorkerRunData;
    approval: ApprovalRequestData;
}

export interface ApprovalRequestCreateInput {
    taskId?: string;
    workerRunId?: string;
    kind: ApprovalRequestKind;
    title: string;
    summary?: string;
    payload?: Record<string, unknown>;
    dueAt?: string;
}

export interface ApprovalRequestResolution {
    decision: "APPROVED" | "REJECTED";
    responseNote?: string;
}

export interface WaitForApprovalResolutionInput {
    approvalId: string;
    taskId: string;
    timeoutMs?: number;
    autoWatchTask?: boolean;
}

export interface WaitForApprovalResolutionResult {
    approval?: ApprovalRequestData;
    timedOut: boolean;
    matchedEvent: AgentEventType | null;
    event?: WaitForNodeEventResult["data"];
}

export interface ResumeWorkerRunAfterApprovalInput {
    runId: string;
    approvalId: string;
    taskId: string;
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
}

export interface ResumeWorkerRunAfterApprovalResult {
    run: WorkerRunData;
    approval: ApprovalRequestData;
}

export interface WaitForRequesterReviewOutcomeInput {
    taskId: string;
    timeoutMs?: number;
    autoWatchTask?: boolean;
}

export interface WaitForRequesterReviewOutcomeResult {
    task: TaskDetailsData;
    timedOut: boolean;
    matchedEvent: "TASK_ACCEPTED" | "REVISION_REQUESTED" | "TASK_SETTLED" | null;
    revisionDetails?: unknown;
    event?: WaitForNodeEventResult["data"];
}

export interface SyncWorkerRunWithRequesterReviewInput {
    runId: string;
    outcome: "TASK_ACCEPTED" | "REVISION_REQUESTED" | "TASK_SETTLED";
    percent?: number;
    currentStep?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
}

export interface SyncWorkerRunWithRequesterReviewResult {
    run: WorkerRunData;
    outcome: "TASK_ACCEPTED" | "REVISION_REQUESTED" | "TASK_SETTLED";
}

export interface ExpireOverdueApprovalsInput {
    taskId?: string;
    limit?: number;
    note?: string;
}

export interface ExpireOverdueApprovalsResult {
    expiredCount: number;
    approvals: ApprovalRequestData[];
}

export interface WaitForNodeEventInput {
    events: AgentEventType[];
    taskId?: string;
    runId?: string;
    approvalId?: string;
    timeoutMs?: number;
    autoWatchTask?: boolean;
}

export interface WaitForNodeEventResult {
    matchedEvent: AgentEventType | null;
    timedOut: boolean;
    taskId?: string;
    runId?: string;
    approvalId?: string;
    data?: Record<string, unknown>;
}

export function isActiveWorkerRunStatus(status: WorkerRunStatus | string | undefined) {
    return status === "QUEUED" || status === "STARTING" || status === "RUNNING" || status === "WAITING_APPROVAL";
}

export interface ApprovalRequestData {
    id: string;
    nodeId: string;
    taskId?: string | null;
    workerRunId?: string | null;
    requestedByUserId?: string | null;
    respondedByUserId?: string | null;
    kind: ApprovalRequestKind;
    status: ApprovalRequestStatus;
    title: string;
    summary?: string | null;
    payload?: Record<string, unknown> | null;
    responseNote?: string | null;
    dueAt?: string | Date | null;
    effectiveDueAt?: string | Date | null;
    timeoutWindowMinutes?: number;
    timeoutSource?: "explicit" | "policy_default";
    isOverdue?: boolean;
    resolvedAt?: string | Date | null;
    createdAt?: string | Date;
    updatedAt?: string | Date;
    workerRun?: {
        id: string;
        status: WorkerRunStatus;
        displayName?: string | null;
        currentStep?: string | null;
    } | null;
    task?: {
        id: string;
        title?: string | null;
        status?: string | null;
    } | null;
}

export interface CurrentUserData {
    id: string;
    walletAddress: string;
    role?: string;
    name?: string | null;
    avatarUrl?: string | null;
    email?: string | null;
    createdAt?: string | Date;
    providerProfile?: ProviderProfileData | null;
    agentNode?: AgentNodeData | null;
}

export interface GetMyTasksOptions {
    limit?: number;
    offset?: number;
    status?: string;
    assignment?: string;
    sortBy?: string;
}

export interface AgentNotification {
    id: string;
    userId: string;
    event: string;
    data: Record<string, unknown> | null;
    readAt: string | null;
    createdAt: string;
}

export interface NodeActionLogEntry {
    id: string;
    source: "record";
    createdAt: string | Date;
    scope: string;
    event: string;
    taskId?: string | null;
    workerRunId?: string | null;
    approvalId?: string | null;
    summary: string;
    note?: string | null;
    task?: {
        id: string;
        title?: string | null;
        status?: string | null;
    } | null;
    payload?: Record<string, unknown> | null;
}

export interface NodeOpsIssue<T = unknown> {
    id: string;
    level: "info" | "warning" | "critical";
    reason: string;
    minutesSinceHeartbeat?: number | null;
    minutesPending?: number | null;
    minutesSinceUpdate?: number | null;
    overdue?: boolean;
    run?: WorkerRunData;
    approval?: ApprovalRequestData;
    task?: T;
}

export interface NodeOpsOverviewData {
    node: {
        id: string;
        displayName: string;
        status?: AgentNodeStatus | string | null;
        automationMode?: AgentNodeAutomationMode | string | null;
    };
    thresholds: {
        staleWorkerHeartbeatMinutes: number;
        stuckApprovalMinutes: number;
    };
    summary: {
        staleWorkerRuns: number;
        blockedApprovals: number;
        pendingApprovals: number;
        attentionTasks: number;
        criticalIssues: number;
    };
    staleWorkerRuns: NodeOpsIssue[];
    blockedApprovals: NodeOpsIssue[];
    tasksNeedingAttention: NodeOpsIssue<{
        id: string;
        title: string;
        status: string;
        createdAt?: string;
        updatedAt?: string;
        rewardAmount?: string;
    }>[];
}

export interface NodeTaskFeedTask {
    id: string;
    source: "hub";
    title: string;
    description: string;
    status: string;
    requester?: {
        id: string;
        name?: string | null;
        walletAddress?: string | null;
    } | null;
    provider?: {
        id: string;
        name?: string | null;
        walletAddress?: string | null;
    } | null;
    nodeId?: string | null;
    rewardAmount?: string | null;
    tokenAddress?: string | null;
    category?: string | null;
    difficulty?: string | null;
    urgency?: string | null;
    tags?: string[];
    constraints?: string[];
    acceptanceCriteria?: string[];
    summary?: string | null;
    materials?: {
        publicResourcesText?: string;
        confidentialResourcesText?: string;
        referenceLinks?: unknown[];
    };
    workerRuns?: WorkerRunData[];
    pendingApprovals?: ApprovalRequestData[];
    createdAt?: string | Date;
    updatedAt?: string | Date;
}

export interface NodeTaskFeedData {
    source: "hub";
    capturedAt: string;
    node: {
        id: string;
        displayName: string;
        status?: AgentNodeStatus | string | null;
        automationMode?: AgentNodeAutomationMode | string | null;
    };
    pending: number;
    tasks: NodeTaskFeedTask[];
    pagination: {
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
    };
}

export interface WorkerRunActionResult {
    action: WorkerRunAction;
    run: WorkerRunData;
    replacementRun?: WorkerRunData | null;
}

export interface TaskActionResult {
    action: TaskAction;
    note?: string;
    task: {
        id: string;
        title: string;
        status: string;
        requesterId?: string;
    };
}

/**
 * Well-known agent lifecycle events.
 *
 * TASK_CREATED          - New task published on platform
 * ASSIGNMENT_SIGNATURE  - Platform selected this agent; claim signature delivered for manual decision
 * TASK_DETAILS          - Confidential materials payload pushed by the platform
 * TASK_CLAIMED          - Agent claimed the task and entered Working
 * REVISION_REQUESTED    - Requester requested revision with criteria results
 * TASK_ACCEPTED         - Requester accepted delivery, funds released
 * TASK_DELIVERED        - Delivery submitted (hash on-chain)
 * TASK_SETTLED          - Auto-settlement triggered at revision limit
 * TASK_ABANDONED        - Agent voluntarily abandoned the task
 * TASK_SUSPENDED        - Task suspended after 3 declines
 * CHAT_MESSAGE          - New chat message received
 * CLARIFICATION_UPDATED - Clarification lifecycle changed on the task
 * NODE_WORKER_RUN_CREATED - A worker run started under the Node
 * NODE_WORKER_RUN_UPDATED - A worker run changed status or progress
 * NODE_APPROVAL_REQUESTED - A worker escalated to the Node owner
 * NODE_APPROVAL_RESOLVED - The owner resolved an approval gate
 * NODE_TASK_FEED_UPDATED - The assigned node task feed changed and should be refetched
 * NODE_UPDATED           - Node profile or operating mode changed
 * NODE_INTERVENTION_EXECUTED - An owner intervention action was applied
 */
export type AgentEventType =
    | "TASK_CREATED"
    | "ASSIGNMENT_SIGNATURE"
    | "TASK_DETAILS"
    | "TASK_CLAIMED"
    | "REVISION_REQUESTED"
    | "TASK_ACCEPTED"
    | "TASK_DELIVERED"
    | "TASK_SETTLED"
    | "TASK_ABANDONED"
    | "TASK_SUSPENDED"
    | "TASK_NUDGED_BY_NODE"
    | "TASK_MANUAL_REVIEW_REQUESTED"
    | "NODE_TASK_NOTE_ADDED"
    | "CHAT_MESSAGE"
    | "CLARIFICATION_UPDATED"
    | "NODE_WORKER_RUN_CREATED"
    | "NODE_WORKER_RUN_UPDATED"
    | "NODE_APPROVAL_REQUESTED"
    | "NODE_APPROVAL_RESOLVED"
    | "NODE_TASK_FEED_UPDATED"
    | "NODE_UPDATED"
    | "NODE_INTERVENTION_EXECUTED"
    | "connected"
    | "disconnected"
    | "reconnecting"
    | string;