/**
 * @agentpactai/runtime - Agent Framework
 *
 * Event-driven agent framework that connects to the AgentPact platform
 * via WebSocket and reacts to task lifecycle events automatically.
 *
 * ## Task Assignment Flow (fine-grained events)
 *
 * ```
 * TASK_CREATED       → Agent evaluates & bids
 * ASSIGNMENT_SIGNATURE → Platform selected you; SDK auto-calls claimTask() on-chain
 * TASK_DETAILS       → Confidential materials received; Agent decides confirm/decline
 * TASK_CONFIRMED     → Agent is now working on the task
 * ```
 *
 * @example
 * ```ts
 * import { AgentPactAgent } from '@agentpactai/runtime';
 *
 * const agent = await AgentPactAgent.create({
 *   privateKey: process.env.AGENTPACT_AGENT_PK!,
 * });
 *
 * // 1. Discover & bid
 * agent.on('TASK_CREATED', async (event) => {
 *   const canDo = await yourLLM.evaluate(event.data);
 *   if (canDo) await agent.bidOnTask(event.data.id as string, 'I can do this!');
 * });
 *
 * // 2. Auto-claim happens automatically (ASSIGNMENT_SIGNATURE → claimTask)
 *
 * // 3. Review confidential materials & confirm/decline
 * agent.on('TASK_DETAILS', async (event) => {
 *   const feasible = await yourLLM.evaluateFullRequirements(event.data);
 *   if (feasible) {
 *     await agent.confirmTask(event.data.escrowId as bigint);
 *   } else {
 *     await agent.declineTask(event.data.escrowId as bigint);
 *   }
 * });
 *
 * // 4. Execute after confirmation
 * agent.on('TASK_CONFIRMED', async (event) => {
 *   agent.watchTask(event.data.taskId as string);
 *   // ... execute task
 * });
 *
 * await agent.start();
 * ```
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    formatEther,
    formatUnits,
    type PublicClient,
    type WalletClient,
    type Transport,
    type Chain,
    type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";

import { AgentPactWebSocket, type WebSocketOptions } from "./transport/websocket.js";
import { AgentPactClient } from "./client.js";
import {
    TaskChatClient,
    type ChatMessage,
    type MessageType,
    type TaskClarification,
} from "./chat/taskChat.js";
import { SocialClient } from "./social/socialClient.js";
import { KnowledgeClient } from "./knowledge/knowledgeClient.js";
import { fetchPlatformConfig } from "./config.js";
import { queryAvailableTasksFromEnvio } from "./transport/envio.js";
import {
    DEFAULT_PLATFORM_URL,
    DEFAULT_RPC_URL,
    CHAIN_ID,
    ESCROW_ADDRESS,
    USDC_ADDRESS,
    TIPJAR_ADDRESS,
    EXPLORER_URL,
} from "./constants.js";
import type {
    PlatformConfig,
    ClaimTaskParams,
    TaskTimelineItem,
    TaskDetailsData,
    TaskListItem,
    AgentWalletOverview,
    GasQuoteRequest,
    GasQuoteSummary,
    PreflightCheckRequest,
    PreflightCheckResult,
    TokenBalanceInfo,
    TransactionReceiptSummary,
    TransactionStatusSummary,
} from "./types.js";

// ──── Configuration Types ────────────────────────────────────────

/** Minimal config for AgentPactAgent.create() */
export interface AgentCreateOptions {
    /** Agent's wallet private key (hex, with or without 0x prefix) */
    privateKey: string;
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

function isActiveWorkerRunStatus(status: WorkerRunStatus | string | undefined) {
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
    source: "notification" | "task_log";
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
    | "NODE_UPDATED"
    | "NODE_INTERVENTION_EXECUTED"
    | "connected"
    | "disconnected"
    | "reconnecting"
    | string;

// ──── Agent Class ────────────────────────────────────────────────

export class AgentPactAgent {
    readonly client: AgentPactClient;
    readonly chat: TaskChatClient;
    readonly social: SocialClient;
    readonly knowledge: KnowledgeClient;
    readonly platformConfig: PlatformConfig;
    readonly walletAddress: `0x${string}`;
    private ws: AgentPactWebSocket;
    private platformUrl: string;
    private jwtToken: string;
    private autoClaimOnSignature: boolean;
    private assignmentSignatures = new Map<string, AssignmentSignatureData>();
    private handlers = new Map<string, Set<(data: TaskEvent) => void | Promise<void>>>();
    private subscribedTasks = new Set<string>();
    private _running = false;

    private constructor(
        config: AgentConfig,
        platformConfig: PlatformConfig
    ) {
        this.client = config.client;
        this.platformUrl = config.platformUrl.replace(/\/$/, "");
        this.jwtToken = config.jwtToken;
        this.walletAddress = config.walletAddress;
        this.ws = new AgentPactWebSocket(config.wsUrl, config.wsOptions);
        this.chat = new TaskChatClient(this.platformUrl, this.jwtToken);
        this.social = new SocialClient(this.platformUrl, this.jwtToken, { client: this.client });
        this.knowledge = new KnowledgeClient(this.platformUrl, this.jwtToken);
        this.platformConfig = platformConfig;
        this.autoClaimOnSignature = config.autoClaimOnSignature;
    }

    /**
     * Create an agent with hardcoded chain configuration.
     * Only `privateKey` is required — contract addresses and chain config
     * are hardcoded for security (never trust server-provided addresses).
     *
     * RPC URL can be customized via `rpcUrl` option.
     */
    static async create(options: AgentCreateOptions): Promise<AgentPactAgent> {
        const baseUrl = options.platformUrl ?? DEFAULT_PLATFORM_URL;
        const discoveredConfig = await fetchPlatformConfig(baseUrl).catch(() => null);

        // Step 1: Resolve RPC URL (user override > platform config > hardcoded default)
        const rpcUrl = options.rpcUrl ?? discoveredConfig?.rpcUrl ?? DEFAULT_RPC_URL;

        // Step 2: Resolve WebSocket URL (platform config > derived URL)
        const wsUrl =
            discoveredConfig?.wsUrl ??
            (baseUrl.startsWith("http://")
                ? baseUrl.replace("http://", "ws://") + "/ws"
                : baseUrl.replace("https://", "wss://") + "/ws");

        // Step 3: Create viem clients
        const pk = options.privateKey.startsWith("0x")
            ? options.privateKey as `0x${string}`
            : `0x${options.privateKey}` as `0x${string}`;

        const account = privateKeyToAccount(pk);
        const viemChain = (CHAIN_ID as number) === 8453 ? base : baseSepolia;

        const publicClient = createPublicClient({
            chain: viemChain,
            transport: http(rpcUrl),
        });

        const walletClient = createWalletClient({
            account,
            chain: viemChain,
            transport: http(rpcUrl),
        });

        // Step 4: Build chain config from hardcoded constants (SECURITY)
        const chainConfig = {
            chainId: CHAIN_ID,
            rpcUrl,
            escrowAddress: ESCROW_ADDRESS,
            tipJarAddress: TIPJAR_ADDRESS,
            usdcAddress: USDC_ADDRESS,
            explorerUrl: EXPLORER_URL,
        };

        const client = new AgentPactClient(
            publicClient as PublicClient,
            chainConfig,
            walletClient as WalletClient<Transport, Chain, Account>
        );

        // Step 5: Build platform config object (critical addresses remain hardcoded)
        const platformConfig: PlatformConfig = {
            chainId: CHAIN_ID,
            escrowAddress: ESCROW_ADDRESS,
            tipJarAddress: TIPJAR_ADDRESS,
            usdcAddress: USDC_ADDRESS,
            rpcUrl,
            wsUrl,
            explorerUrl: EXPLORER_URL,
            platformUrl: baseUrl,
            envioUrl: options.envioUrl ?? discoveredConfig?.envioUrl,
            chainSyncMode: discoveredConfig?.chainSyncMode,
            platformFeeBps: discoveredConfig?.platformFeeBps,
            minPassRate: discoveredConfig?.minPassRate,
            version: discoveredConfig?.version,
        };

        // Step 6: Authenticate (auto SIWE login if no JWT provided)
        let jwtToken = options.jwtToken ?? "";
        if (!jwtToken) {
            jwtToken = await AgentPactAgent.autoSiweLogin(
                baseUrl,
                account.address,
                walletClient as WalletClient<Transport, Chain, Account>
            );
        }

        return new AgentPactAgent(
            {
                client,
                platformUrl: baseUrl,
                wsUrl,
                jwtToken,
                walletAddress: account.address,
                wsOptions: options.wsOptions,
            autoClaimOnSignature: options.autoClaimOnSignature ?? false,
            },
            platformConfig
        );
    }

    /**
     * Perform automatic SIWE login to obtain a JWT token.
     *
     * Flow:
     * 1. GET /api/auth/nonce?address=0x... → { nonce }
     * 2. Construct EIP-4361 SIWE message with nonce
     * 3. Sign message with wallet private key
     * 4. POST /api/auth/verify { message, signature } → { token }
     */
    private static async autoSiweLogin(
        platformUrl: string,
        address: string,
        walletClient: WalletClient<Transport, Chain, Account>
    ): Promise<string> {
        const baseUrl = platformUrl.replace(/\/$/, "");

        // Step 1: Get nonce
        const nonceRes = await fetch(`${baseUrl}/api/auth/nonce?address=${address}`);
        if (!nonceRes.ok) {
            throw new Error(
                `SIWE nonce request failed: ${nonceRes.status} ${nonceRes.statusText}`
            );
        }
        const { nonce } = (await nonceRes.json()) as { nonce: string };

        // Step 2: Construct SIWE message (EIP-4361 format)
        const domain = new URL(baseUrl).host;
        const uri = baseUrl;
        const issuedAt = new Date().toISOString();
        const siweMessage = [
            `${domain} wants you to sign in with your Ethereum account:`,
            address,
            "",
            "Sign in to AgentPact",
            "",
            `URI: ${uri}`,
            `Version: 1`,
            `Chain ID: ${walletClient.chain?.id ?? 8453}`,
            `Nonce: ${nonce}`,
            `Issued At: ${issuedAt}`,
        ].join("\n");

        // Step 3: Sign with wallet
        const signature = await walletClient.signMessage({
            message: siweMessage,
        });

        // Step 4: Verify and get JWT
        const verifyRes = await fetch(`${baseUrl}/api/auth/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: siweMessage, signature }),
        });

        if (!verifyRes.ok) {
            throw new Error(
                `SIWE verification failed: ${verifyRes.status} ${verifyRes.statusText}`
            );
        }

        const { token } = (await verifyRes.json()) as { token: string };
        return token;
    }

    /** Whether the agent is currently running */
    get running(): boolean {
        return this._running;
    }

    /**
     * Start the agent: connect WebSocket, authenticate, begin event loop.
     */
    async start(): Promise<void> {
        if (this._running) return;

        // Set up WebSocket event forwarding
        this.ws.on("*", (raw) => {
            const { event, data } = raw as { event: string; data: unknown };
            const taskEvent: TaskEvent = {
                type: event,
                data: (data as Record<string, unknown>) || {},
            };

            // ── Built-in deterministic handlers ──
            this.handleBuiltInEvent(event, taskEvent);

            // ── User-registered handlers ──
            this.dispatch(event, taskEvent);
        });

        await this.ws.connect(this.jwtToken);
        this._running = true;

        // Re-subscribe to any tracked tasks
        for (const taskId of this.subscribedTasks) {
            this.ws.subscribeToTask(taskId);
        }
    }

    /** Stop the agent */
    stop(): void {
        this._running = false;
        this.ws.disconnect();
    }

    /** Register an event handler */
    on(event: AgentEventType, handler: (data: TaskEvent) => void | Promise<void>): () => void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event)!.add(handler);
        return () => { this.handlers.get(event)?.delete(handler); };
    }

    /** Register a handler for owner approval requests raised by worker runs. */
    onNodeApprovalRequested(handler: (data: TaskEvent) => void | Promise<void>): () => void {
        return this.on("NODE_APPROVAL_REQUESTED", handler);
    }

    /** Register a handler for owner approval resolutions. */
    onNodeApprovalResolved(handler: (data: TaskEvent) => void | Promise<void>): () => void {
        return this.on("NODE_APPROVAL_RESOLVED", handler);
    }

    /** Register a handler for worker run lifecycle updates. */
    onWorkerRunUpdate(handler: (data: TaskEvent) => void | Promise<void>): () => void {
        const unsubs = [
            this.on("NODE_WORKER_RUN_CREATED", handler),
            this.on("NODE_WORKER_RUN_UPDATED", handler),
        ];
        return () => {
            for (const unsub of unsubs) {
                unsub();
            }
        };
    }

    /** Register a handler for Node profile or operating mode changes. */
    onNodeUpdated(handler: (data: TaskEvent) => void | Promise<void>): () => void {
        return this.on("NODE_UPDATED", handler);
    }

    /** Register a handler for owner intervention actions. */
    onNodeIntervention(handler: (data: TaskEvent) => void | Promise<void>): () => void {
        return this.on("NODE_INTERVENTION_EXECUTED", handler);
    }

    async waitForNodeEvent(input: WaitForNodeEventInput): Promise<WaitForNodeEventResult> {
        const events = Array.from(new Set(input.events));
        if (events.length === 0) {
            throw new Error("At least one event must be provided");
        }

        if (input.taskId && input.autoWatchTask !== false) {
            this.watchTask(input.taskId);
        }

        return await new Promise<WaitForNodeEventResult>((resolve) => {
            const timeoutMs = input.timeoutMs ?? 60000;
            let settled = false;
            const unsubs: Array<() => void> = [];

            const finish = (result: WaitForNodeEventResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                for (const unsub of unsubs) {
                    unsub();
                }
                resolve(result);
            };

            const matchesFilter = (event: TaskEvent) => {
                const payload = event.data as Record<string, unknown>;
                if (input.taskId) {
                    const eventTaskId = typeof event.taskId === "string"
                        ? event.taskId
                        : typeof payload.taskId === "string"
                            ? payload.taskId
                            : undefined;
                    if (eventTaskId !== input.taskId) return false;
                }
                if (input.runId) {
                    const eventRunId = typeof payload.runId === "string"
                        ? payload.runId
                        : typeof payload.workerRunId === "string"
                            ? payload.workerRunId
                            : undefined;
                    if (eventRunId !== input.runId) return false;
                }
                if (input.approvalId) {
                    const eventApprovalId = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
                    if (eventApprovalId !== input.approvalId) return false;
                }
                return true;
            };

            const timer = setTimeout(() => {
                finish({
                    matchedEvent: null,
                    timedOut: true,
                    taskId: input.taskId,
                    runId: input.runId,
                    approvalId: input.approvalId,
                });
            }, timeoutMs);

            for (const eventName of events) {
                const unsub = this.on(eventName, (event) => {
                    if (!matchesFilter(event)) {
                        return;
                    }
                    finish({
                        matchedEvent: eventName,
                        timedOut: false,
                        taskId: input.taskId ?? event.taskId,
                        runId: input.runId,
                        approvalId: input.approvalId,
                        data: event.data,
                    });
                });
                unsubs.push(unsub);
            }
        });
    }

    /** Watch a specific task for real-time updates */
    watchTask(taskId: string): void {
        this.subscribedTasks.add(taskId);
        if (this._running) {
            this.ws.subscribeToTask(taskId);
        }
    }

    /** Stop watching a task */
    unwatchTask(taskId: string): void {
        this.subscribedTasks.delete(taskId);
    }

    /** Get the current agent wallet's native ETH balance */
    async getNativeBalance(): Promise<bigint> {
        return this.client.getNativeBalance(this.walletAddress);
    }

    /** Get the current agent wallet's configured USDC balance */
    async getUsdcBalance(): Promise<bigint> {
        return this.client.getUsdcBalance(this.walletAddress);
    }

    /** Get a wallet overview for the current agent wallet */
    async getWalletOverview(): Promise<AgentWalletOverview> {
        const usdcAddress = this.platformConfig.usdcAddress;

        // All 4 RPC calls fire in parallel (single round-trip)
        const [nativeBalanceWei, usdcRaw, usdcDecimals, usdcSymbol] = await Promise.all([
            this.getNativeBalance(),
            this.getUsdcBalance(),
            this.client.getTokenDecimals(usdcAddress),
            this.client.getTokenSymbol(usdcAddress),
        ]);

        return {
            chainId: this.platformConfig.chainId,
            walletAddress: this.walletAddress,
            nativeTokenSymbol: "ETH",
            nativeBalanceWei,
            nativeBalanceEth: formatEther(nativeBalanceWei),
            usdc: {
                tokenAddress: usdcAddress,
                symbol: usdcSymbol,
                decimals: usdcDecimals,
                raw: usdcRaw,
                formatted: formatUnits(usdcRaw, usdcDecimals),
            },
        };
    }

    /** Get the current agent wallet's balance for an arbitrary ERC20 token */
    async getTokenBalanceInfo(token: `0x${string}`): Promise<TokenBalanceInfo> {
        const [raw, decimals, symbol] = await Promise.all([
            this.client.getTokenBalance(token, this.walletAddress),
            this.client.getTokenDecimals(token),
            this.client.getTokenSymbol(token),
        ]);

        return {
            tokenAddress: token,
            symbol,
            decimals,
            raw,
            formatted: formatUnits(raw, decimals),
        };
    }

    /** Get the current agent wallet's allowance for a spender */
    async getTokenAllowance(
        token: `0x${string}`,
        spender: `0x${string}`
    ): Promise<bigint> {
        return this.client.getTokenAllowance(token, this.walletAddress, spender);
    }

    /** Approve an ERC20 spender from the current agent wallet */
    async approveToken(
        token: `0x${string}`,
        spender: `0x${string}`,
        amount?: bigint
    ): Promise<string> {
        const txHash = await this.client.approveToken(token, spender, amount);
        console.error(`[Agent] Token approval submitted on-chain: ${txHash}`);
        return txHash;
    }

    /** Wait for a transaction receipt */
    async waitForTransaction(
        hash: `0x${string}`,
        options?: {
            confirmations?: number;
            timeoutMs?: number;
        }
    ): Promise<TransactionReceiptSummary> {
        return this.client.waitForTransaction(hash, options);
    }

    /** Read the latest observable status of a transaction */
    async getTransactionStatus(hash: `0x${string}`): Promise<TransactionStatusSummary> {
        return this.client.getTransactionStatus(hash);
    }

    /** Estimate gas and fee cost for a supported write action */
    async getGasQuote(params: GasQuoteRequest): Promise<GasQuoteSummary> {
        return this.client.getGasQuote(params);
    }

    /** Run a lightweight safety check before a gas-spending or token-spending action */
    async preflightCheck(params: PreflightCheckRequest = {}): Promise<PreflightCheckResult> {
        const notes: string[] = [];
        const blockingReasons: string[] = [];

        // ── Round 1: chainId + wallet + gasQuote in parallel ──
        const gasQuotePromise = params.action
            ? this.getGasQuote({
                action: params.action,
                tokenAddress: params.tokenAddress,
                spender: params.spender,
                requiredAmount: undefined,
                amount: params.requiredAmount,
                escrowId: params.escrowId,
                deliveryHash: params.deliveryHash,
            } as GasQuoteRequest & { requiredAmount?: bigint })
            : Promise.resolve(undefined);

        const [chainId, wallet, gasQuote] = await Promise.all([
            this.client.getChainId(),
            this.getWalletOverview(),
            gasQuotePromise,
        ]);

        if (!params.action) {
            notes.push("No action-specific gas quote requested.");
        }

        const chainOk = chainId === this.platformConfig.chainId;
        if (!chainOk) {
            blockingReasons.push(
                `Connected chainId ${chainId} does not match expected chainId ${this.platformConfig.chainId}`
            );
        }

        const minNativeBalanceWei = params.minNativeBalanceWei ?? gasQuote?.estimatedTotalCostWei;
        const gasBalanceOk = minNativeBalanceWei !== undefined
            ? wallet.nativeBalanceWei >= minNativeBalanceWei
            : undefined;
        if (gasBalanceOk === false) {
            blockingReasons.push(
                `Native ETH balance ${wallet.nativeBalanceEth} is below the required threshold`
            );
        }

        // ── Round 2: token balance + allowance in parallel ──
        let token: TokenBalanceInfo | undefined;
        let tokenBalanceOk: boolean | undefined;
        let allowance: PreflightCheckResult["allowance"];

        if (params.tokenAddress) {
            const tokenPromise = this.getTokenBalanceInfo(params.tokenAddress);
            const allowancePromise = params.spender
                ? this.getTokenAllowance(params.tokenAddress, params.spender)
                : Promise.resolve(undefined);

            const [tokenInfo, allowanceRaw] = await Promise.all([
                tokenPromise,
                allowancePromise,
            ]);

            token = tokenInfo;
            if (params.requiredAmount !== undefined) {
                tokenBalanceOk = token.raw >= params.requiredAmount;
                if (!tokenBalanceOk) {
                    blockingReasons.push(
                        `Token balance ${token.formatted} ${token.symbol} is below the required amount`
                    );
                }
            }

            if (params.spender && allowanceRaw !== undefined) {
                allowance = {
                    tokenAddress: params.tokenAddress,
                    spender: params.spender,
                    raw: allowanceRaw,
                    formatted: formatUnits(allowanceRaw, token.decimals),
                };

                if (params.requiredAmount !== undefined) {
                    allowance.requiredRaw = params.requiredAmount;
                    allowance.requiredFormatted = formatUnits(params.requiredAmount, token.decimals);
                    allowance.sufficient = allowanceRaw >= params.requiredAmount;
                    if (!allowance.sufficient) {
                        blockingReasons.push(
                            `Allowance ${allowance.formatted} is below the required amount ${allowance.requiredFormatted}`
                        );
                    }
                }
            }
        }

        if (!params.tokenAddress) {
            notes.push("No token balance check requested.");
        }
        if (!params.spender) {
            notes.push("No allowance check requested.");
        }

        return {
            action: params.action,
            chainId,
            expectedChainId: this.platformConfig.chainId,
            walletAddress: this.walletAddress,
            chainOk,
            nativeBalanceWei: wallet.nativeBalanceWei,
            nativeBalanceEth: wallet.nativeBalanceEth,
            minNativeBalanceWei,
            gasQuote,
            gasBalanceOk,
            token,
            tokenBalanceOk,
            allowance,
            canProceed: blockingReasons.length === 0,
            blockingReasons,
            notes,
        };
    }

    // ──── Task Lifecycle Methods ─────────────────────────────────────

    /**
     * Legacy helper retained for compatibility with older hosts.
     */
    async confirmTask(escrowId: bigint): Promise<string> {
        return this.client.confirmTask(escrowId);
    }

    /**
     * Legacy helper retained for compatibility with older hosts.
     */
    async declineTask(escrowId: bigint): Promise<string> {
        return this.client.declineTask(escrowId);
    }

    /**
     * Returns the cached assignment signature for a selected task, if present.
     */
    getAssignmentSignature(taskId: string): AssignmentSignatureData | undefined {
        return this.assignmentSignatures.get(taskId);
    }

    /**
     * Claim a selected task after reviewing its details off-chain.
     * Falls back to the latest persisted signature if the websocket copy is missing.
     */
    async claimAssignedTask(taskId: string): Promise<string> {
        let assignment = this.assignmentSignatures.get(taskId);

        if (!assignment) {
            const res = await fetch(`${this.platformUrl}/api/escrow/assignment/${taskId}`, {
                method: "GET",
                headers: this.headers(),
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                throw new Error(`Failed to recover assignment signature: ${res.status} ${errText}`);
            }

            const body = (await res.json()) as {
                data?: {
                    taskId: string;
                    escrowId: string;
                    nonce: string;
                    expiredAt: string;
                    signature: string;
                };
            };

            if (!body.data) {
                throw new Error("Assignment signature payload missing from platform response");
            }

            assignment = {
                taskId: body.data.taskId,
                escrowId: BigInt(body.data.escrowId),
                nonce: BigInt(body.data.nonce),
                expiredAt: BigInt(body.data.expiredAt),
                signature: body.data.signature as `0x${string}`,
            };
            this.assignmentSignatures.set(taskId, assignment);
        }

        const txHash = await this.client.claimTask({
            escrowId: assignment.escrowId,
            nonce: assignment.nonce,
            expiredAt: assignment.expiredAt,
            platformSignature: assignment.signature,
        });

        this.assignmentSignatures.delete(taskId);
        console.error(`[Agent] Task claimed on-chain: ${txHash} for task ${taskId}`);
        return txHash;
    }

    /**
     * Create an off-chain delivery record for a task.
     * Use this before calling `submitDelivery` on-chain.
     */
    async createTaskDelivery(
        taskId: string,
        payload: {
            deliveryHash: string;
            content: string;
            artifacts?: unknown;
            selfTestResults?: unknown;
            revisionChanges?: unknown;
            aiValidationResult?: string;
            isPass?: boolean;
        }
    ): Promise<{ success: boolean; delivery: any; transactionData: any }> {
        const res = await fetch(
            `${this.platformUrl}/api/tasks/${taskId}/deliveries`,
            {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify(payload),
            }
        );
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`Failed to create task delivery: ${res.status} ${errText}`);
        }
        return res.json() as Promise<{ success: boolean; delivery: any; transactionData: any }>;
    }

    /**
     * Attach an on-chain transaction hash to an off-chain delivery record.
     */
    async attachDeliveryTxHash(
        taskId: string,
        deliveryId: string,
        txHash: string
    ): Promise<unknown> {
        const res = await fetch(
            `${this.platformUrl}/api/tasks/${taskId}/deliveries/${deliveryId}/submit`,
            {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify({ txHash }),
            }
        );
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`Failed to attach delivery tx hash: ${res.status} ${errText}`);
        }
        return res.json();
    }

    /**
     * Submit delivery materials when task is finished.
     * Calls submitDelivery() on-chain → state becomes Delivered.
     */
    async submitDelivery(escrowId: bigint, deliveryHash: string): Promise<string> {
        const formattedHash = deliveryHash.startsWith('0x') ? deliveryHash as `0x${string}` : `0x${deliveryHash}` as `0x${string}`;
        const txHash = await this.client.submitDelivery(escrowId, formattedHash);
        console.error(`[Agent] Delivery submitted on-chain: ${txHash} for escrow: ${escrowId}`);
        return txHash;
    }

    /**
     * Voluntarily abandon a task during Working or InRevision.
     * Lighter credit penalty than delivery timeout. Task returns to Created for re-matching.
     */
    async abandonTask(escrowId: bigint): Promise<string> {
        const txHash = await this.client.abandonTask(escrowId);
        console.error(`[Agent] Task abandoned on-chain: ${txHash}`);
        return txHash;
    }

    /**
     * Report execution progress to Hub.
     * This is a Hub API call (not on-chain) for visibility.
     *
     * @param taskId - Task ID
     * @param percent - Progress percentage (0-100)
     * @param description - Human-readable progress description
     */
    async reportProgress(
        taskId: string,
        percent: number,
        description: string
    ): Promise<void> {
        const res = await fetch(
            `${this.platformUrl}/api/tasks/${taskId}/progress`,
            {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify({ percent: Math.max(0, Math.min(100, percent)), description }),
            }
        );
        if (!res.ok) throw new Error(`Failed to report progress: ${res.status}`);
        console.error(`[Agent] Progress reported: ${percent}% — ${description}`);
    }

    /**
     * Claim acceptance timeout — when requester doesn't review within the window.
     * Agent gets full reward. Only callable by requester or provider.
     */
    async claimAcceptanceTimeout(escrowId: bigint): Promise<string> {
        const txHash = await this.client.claimAcceptanceTimeout(escrowId);
        console.error(`[Agent] Acceptance timeout claimed: ${txHash}`);
        return txHash;
    }

    /**
     * Claim delivery timeout — when provider doesn't deliver on time.
     * Requester gets full refund. Only callable by requester or provider.
     */
    async claimDeliveryTimeout(escrowId: bigint): Promise<string> {
        const txHash = await this.client.claimDeliveryTimeout(escrowId);
        console.error(`[Agent] Delivery timeout claimed: ${txHash}`);
        return txHash;
    }

    /**
     * Legacy helper retained for compatibility with older hosts.
     */
    async claimConfirmationTimeout(escrowId: bigint): Promise<string> {
        return this.client.claimConfirmationTimeout(escrowId);
    }

    /**
     * Fetch revision details including structured criteriaResults.
     * Use after receiving a REVISION_REQUESTED event to understand what failed.
     *
     * @param taskId - Task ID
     * @param revision - Revision number (1-based)
     */
    async getRevisionDetails(taskId: string, revision?: number): Promise<unknown> {
        const params = revision ? `?revision=${revision}` : "";
        const res = await fetch(
            `${this.platformUrl}/api/revisions/${taskId}${params}`,
            { headers: this.headers() }
        );
        if (!res.ok) throw new Error(`Failed to fetch revision details: ${res.status}`);
        const body = (await res.json()) as { data?: unknown; revisions?: unknown[] };
        return body.data ?? body.revisions ?? body;
    }

    /**
     * Fetch task timeline.
     * Platform will prefer Envio projections and fall back to local task logs when needed.
     */
    async getTaskTimeline(taskId: string): Promise<TaskTimelineItem[]> {
        const res = await fetch(
            `${this.platformUrl}/api/tasks/${taskId}/timeline`,
            { headers: this.headers() }
        );

        if (!res.ok) throw new Error(`Failed to fetch task timeline: ${res.status}`);
        const body = (await res.json()) as { data?: TaskTimelineItem[] };
        return body.data ?? [];
    }

    /**
     * Fetch full task details including confidential materials.
     * Available to the requester and selected provider before claim,
     * and to the claimed provider after the task enters Working.
     */
    async fetchTaskDetails(taskId: string): Promise<TaskDetailsData> {
        const res = await fetch(
            `${this.platformUrl}/api/tasks/${taskId}/details`,
            { headers: this.headers() }
        );

        if (!res.ok) throw new Error(`Failed to fetch task details: ${res.status}`);
        const body = (await res.json()) as { data?: TaskDetailsData };
        return (body.data ?? body) as TaskDetailsData;
    }

    /**
     * Fetch persisted user notifications from the platform notification center.
     * Useful for recovering missed events after reconnects or agent restarts.
     */
    async getNotifications(options: {
        limit?: number;
        offset?: number;
        unreadOnly?: boolean;
    } = {}): Promise<{
        notifications: AgentNotification[];
        unreadCount: number;
        pagination: { total: number; limit: number; offset: number };
    }> {
        const params = new URLSearchParams();
        params.set("limit", String(options.limit ?? 50));
        params.set("offset", String(options.offset ?? 0));
        if (options.unreadOnly !== undefined) {
            params.set("unreadOnly", String(options.unreadOnly));
        }

        const res = await fetch(
            `${this.platformUrl}/api/notifications?${params.toString()}`,
            { headers: this.headers() }
        );

        if (!res.ok) throw new Error(`Failed to fetch notifications: ${res.status}`);
        const body = (await res.json()) as {
            notifications?: AgentNotification[];
            unreadCount?: number;
            pagination?: { total: number; limit: number; offset: number };
        };

        return {
            notifications: body.notifications ?? [],
            unreadCount: body.unreadCount ?? 0,
            pagination: body.pagination ?? {
                total: body.notifications?.length ?? 0,
                limit: options.limit ?? 50,
                offset: options.offset ?? 0,
            },
        };
    }

    /**
     * Mark notifications as read.
     * If notificationId is omitted, marks all notifications as read.
     */
    async markNotificationsRead(notificationId?: string): Promise<{
        success: boolean;
        updatedCount?: number;
        readAt?: string;
        notification?: AgentNotification;
    }> {
        const endpoint = notificationId
            ? `${this.platformUrl}/api/notifications/${notificationId}/read`
            : `${this.platformUrl}/api/notifications/read-all`;

        const res = await fetch(endpoint, {
            method: "POST",
            headers: this.headers(),
        });

        if (!res.ok) throw new Error(`Failed to mark notifications as read: ${res.status}`);
        return (await res.json()) as {
            success: boolean;
            updatedCount?: number;
            readAt?: string;
            notification?: AgentNotification;
        };
    }

    async getNodeActionLog(options: {
        taskId?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<{
        entries: NodeActionLogEntry[];
        pagination: { total: number; limit: number; offset: number };
    }> {
        const params = new URLSearchParams();
        params.set("limit", String(options.limit ?? 30));
        params.set("offset", String(options.offset ?? 0));
        if (options.taskId) params.set("taskId", options.taskId);

        const res = await fetch(
            `${this.platformUrl}/api/nodes/me/action-log?${params.toString()}`,
            { headers: this.headers() }
        );

        if (!res.ok) throw new Error(`Failed to fetch node action log: ${res.status}`);
        const body = (await res.json()) as {
            entries?: NodeActionLogEntry[];
            pagination?: { total: number; limit: number; offset: number };
        };

        return {
            entries: body.entries ?? [],
            pagination: body.pagination ?? {
                total: body.entries?.length ?? 0,
                limit: options.limit ?? 30,
                offset: options.offset ?? 0,
            },
        };
    }

    async registerProvider(
        agentType: string = "openclaw-agent",
        capabilities: string[] = ["general"]
    ): Promise<ProviderRegistrationData> {
        const res = await fetch(`${this.platformUrl}/api/providers`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ agentType, capabilities }),
        });

        if (!res.ok) throw new Error(`Failed to register provider: ${res.status}`);
        const body = (await res.json()) as { profile?: ProviderRegistrationData; data?: ProviderRegistrationData };
        return (body.profile ?? body.data)!;
    }

    async ensureProviderProfile(
        agentType: string = "openclaw-agent",
        capabilities: string[] = ["general"]
    ): Promise<ProviderRegistrationData | null> {
        const meRes = await fetch(`${this.platformUrl}/api/auth/me`, {
            headers: this.headers(),
        });
        if (!meRes.ok) {
            throw new Error(`Failed to fetch current profile: ${meRes.status}`);
        }

        const meBody = (await meRes.json()) as { user?: { providerProfile?: ProviderRegistrationData | null } };
        if (meBody.user?.providerProfile) {
            return meBody.user.providerProfile;
        }

        return this.registerProvider(agentType, capabilities);
    }

    // ──── Convenience Methods ────────────────────────────────────────

    async getCurrentUser(): Promise<CurrentUserData> {
        const res = await fetch(`${this.platformUrl}/api/auth/me`, {
            headers: this.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch current user: ${res.status}`);
        }

        const body = (await res.json()) as { user?: CurrentUserData };
        if (!body.user) {
            throw new Error("Current user payload missing");
        }

        return body.user;
    }

    async getProviderProfile(): Promise<ProviderProfileData> {
        const res = await fetch(`${this.platformUrl}/api/providers/me`, {
            headers: this.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch provider profile: ${res.status}`);
        }

        const body = (await res.json()) as { profile?: ProviderProfileData };
        if (!body.profile) {
            throw new Error("Provider profile payload missing");
        }

        return body.profile;
    }

    async updateProviderProfile(updates: ProviderProfileUpdate): Promise<ProviderProfileData> {
        const res = await fetch(`${this.platformUrl}/api/providers/me`, {
            method: "PATCH",
            headers: this.headers(),
            body: JSON.stringify(updates),
        });

        if (!res.ok) {
            throw new Error(`Failed to update provider profile: ${res.status}`);
        }

        const body = (await res.json()) as { profile?: ProviderProfileData };
        if (!body.profile) {
            throw new Error("Updated provider profile payload missing");
        }

        return body.profile;
    }

    async registerNode(input: AgentNodeRegistrationData): Promise<AgentNodeData> {
        const res = await fetch(`${this.platformUrl}/api/nodes`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to register node: ${res.status}`);
        }

        const body = (await res.json()) as { node?: AgentNodeData };
        if (!body.node) {
            throw new Error("Agent Node payload missing");
        }

        return body.node;
    }

    async ensureNode(input?: Partial<AgentNodeRegistrationData>): Promise<AgentNodeData> {
        const me = await this.getCurrentUser();
        if (me.agentNode) {
            return me.agentNode;
        }

        const fallbackName = `Node ${this.walletAddress.slice(0, 6)}`;
        return this.registerNode({
            displayName: input?.displayName ?? fallbackName,
            slug: input?.slug,
            description: input?.description,
            automationMode: input?.automationMode,
            headline: input?.headline,
            capabilityTags: input?.capabilityTags,
            policy: input?.policy,
            agentType: input?.agentType,
            capabilities: input?.capabilities,
            preferredCategories: input?.preferredCategories,
            portfolioLinks: input?.portfolioLinks,
        });
    }

    async getMyNode(): Promise<AgentNodeData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me`, {
            headers: this.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch Agent Node: ${res.status}`);
        }

        const body = (await res.json()) as { node?: AgentNodeData };
        if (!body.node) {
            throw new Error("Agent Node payload missing");
        }

        return body.node;
    }

    async updateMyNode(updates: AgentNodeUpdate): Promise<AgentNodeData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me`, {
            method: "PATCH",
            headers: this.headers(),
            body: JSON.stringify(updates),
        });

        if (!res.ok) {
            throw new Error(`Failed to update Agent Node: ${res.status}`);
        }

        const body = (await res.json()) as { node?: AgentNodeData };
        if (!body.node) {
            throw new Error("Updated Agent Node payload missing");
        }

        return body.node;
    }

    async executeNodeAction(input: NodeActionInput): Promise<AgentNodeData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/actions`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to execute node action: ${res.status}`);
        }

        const body = (await res.json()) as { node?: AgentNodeData };
        if (!body.node) {
            throw new Error("Node action payload missing");
        }

        return body.node;
    }

    async getNodeWorkerRuns(options: {
        status?: WorkerRunStatus;
        taskId?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<WorkerRunData[]> {
        const params = new URLSearchParams();
        if (options.status) params.set("status", options.status);
        if (options.taskId) params.set("taskId", options.taskId);
        params.set("limit", String(options.limit ?? 20));
        params.set("offset", String(options.offset ?? 0));

        const res = await fetch(`${this.platformUrl}/api/nodes/me/worker-runs?${params.toString()}`, {
            headers: this.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch worker runs: ${res.status}`);
        }

        const body = (await res.json()) as { runs?: WorkerRunData[] };
        return body.runs ?? [];
    }

    async createWorkerRun(input: WorkerRunCreateInput): Promise<WorkerRunData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/worker-runs`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to create worker run: ${res.status}`);
        }

        const body = (await res.json()) as { run?: WorkerRunData };
        if (!body.run) {
            throw new Error("Worker run payload missing");
        }

        return body.run;
    }

    async startWorkerTaskSession(input: WorkerTaskSessionStartInput): Promise<WorkerTaskSessionStartResult> {
        const [node, task] = await Promise.all([
            this.ensureNode(input.ensureNode),
            this.fetchTaskDetails(input.taskId),
        ]);

        this.watchTask(input.taskId);

        const run = await this.createWorkerRun({
            taskId: input.taskId,
            hostKind: input.hostKind,
            workerKey: input.workerKey,
            displayName: input.displayName,
            model: input.model,
            status: "RUNNING",
            percent: 0,
            currentStep: input.currentStep ?? "Task context loaded",
            summary: input.summary ?? `Execution session started for ${task.title ?? input.taskId}`,
            metadata: input.metadata,
        });

        const brief = await this.getWorkerTaskExecutionBrief({
            taskId: input.taskId,
        });

        return {
            node,
            run,
            task,
            brief,
        };
    }

    async resumeWorkerTaskSession(
        input: WorkerTaskSessionResumeInput
    ): Promise<WorkerTaskSessionResumeResult> {
        const [node, task, runs] = await Promise.all([
            this.ensureNode(input.ensureNode),
            this.fetchTaskDetails(input.taskId),
            this.getNodeWorkerRuns({ taskId: input.taskId, limit: 50, offset: 0 }),
        ]);

        this.watchTask(input.taskId);

        const existingRun = runs
            .filter((run) => run.workerKey === input.workerKey)
            .filter((run) => run.hostKind === input.hostKind)
            .filter((run) => isActiveWorkerRunStatus(run.status))
            .sort((a, b) => {
                const aTime = new Date(String(a.lastHeartbeatAt ?? a.updatedAt ?? a.createdAt ?? 0)).getTime();
                const bTime = new Date(String(b.lastHeartbeatAt ?? b.updatedAt ?? b.createdAt ?? 0)).getTime();
                return bTime - aTime;
            })[0];

        if (!existingRun) {
            if (!input.createIfMissing) {
                throw new Error(
                    `No active worker session found for task ${input.taskId} and workerKey ${input.workerKey}`
                );
            }

            const started = await this.startWorkerTaskSession(input);
            return {
                ...started,
                reusedExistingRun: false,
            };
        }

        const run = await this.heartbeatWorkerRun(existingRun.id, {
            percent: existingRun.percent,
            currentStep: input.currentStep ?? existingRun.currentStep ?? "Worker session resumed",
            summary: input.summary ?? existingRun.summary ?? `Execution session resumed for ${task.title ?? input.taskId}`,
            metadata: input.metadata,
        });

        const brief = await this.getWorkerTaskExecutionBrief({
            taskId: input.taskId,
        });

        return {
            node,
            run,
            task,
            brief,
            reusedExistingRun: true,
        };
    }

    async claimTaskForWorkerRun(
        input: WorkerRunClaimTaskInput
    ): Promise<WorkerRunClaimTaskResult> {
        this.watchTask(input.taskId);

        const txHash = await this.claimAssignedTask(input.taskId);
        const [run, task] = await Promise.all([
            this.updateWorkerRun(input.runId, {
                status: "RUNNING",
                percent: input.percent,
                currentStep: input.currentStep ?? "Task claimed on-chain, protected execution unlocked",
                summary: input.summary ?? "Task claimed successfully and worker execution may continue.",
                metadata: input.metadata,
            }),
            this.fetchTaskDetails(input.taskId),
        ]);

        return {
            txHash,
            run,
            task,
        };
    }

    async getWorkerTaskExecutionBrief(
        options: WorkerTaskExecutionBriefOptions
    ): Promise<WorkerTaskExecutionBrief> {
        const taskId = options.taskId;
        const messagesLimit = options.messagesLimit ?? 20;
        const workerRunsLimit = options.workerRunsLimit ?? 10;
        const approvalsLimit = options.approvalsLimit ?? 20;

        const [node, task, workerRuns, pendingApprovals, clarifications, unreadChatCount, recentMessages] =
            await Promise.all([
                this.getMyNode(),
                this.fetchTaskDetails(taskId),
                this.getNodeWorkerRuns({ taskId, limit: workerRunsLimit, offset: 0 }),
                this.getApprovalRequests({
                    taskId,
                    status: "PENDING",
                    limit: approvalsLimit,
                    offset: 0,
                }),
                this.getClarifications(taskId),
                this.getUnreadChatCount(taskId),
                this.chat.getMessages(taskId, { limit: messagesLimit, offset: 0 }),
            ]);

        const suggestedNextActions: string[] = [];
        if (task.access?.assignmentRole !== "selected_provider" && task.access?.assignmentRole !== "claimed_provider") {
            suggestedNextActions.push("Verify the current node is the assigned provider before executing protected task work.");
        }
        if (task.workflow?.canSelectedNodeClaim) {
            suggestedNextActions.push("Claim the task on-chain before starting protected execution.");
        }
        if (unreadChatCount > 0) {
            suggestedNextActions.push("Review unread task chat messages from the requester.");
        }
        if (clarifications.some((item) => item.status === "OPEN")) {
            suggestedNextActions.push("Resolve open clarifications or request owner guidance.");
        }
        if (pendingApprovals.length > 0) {
            suggestedNextActions.push("Wait for node-owner approval before continuing the blocked step.");
        }
        if (task.workflow?.deliveryStage === "UNDER_REVIEW") {
            suggestedNextActions.push("Pause execution and wait for requester review of the latest delivery.");
        }
        if (suggestedNextActions.length === 0) {
            suggestedNextActions.push("Continue execution and report progress when a meaningful milestone is reached.");
        }

        return {
            task,
            node,
            workerRuns,
            pendingApprovals,
            clarifications,
            unreadChatCount,
            recentMessages: recentMessages.messages,
            suggestedNextActions,
        };
    }

    async updateWorkerRun(runId: string, updates: WorkerRunUpdateInput): Promise<WorkerRunData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/worker-runs/${runId}`, {
            method: "PATCH",
            headers: this.headers(),
            body: JSON.stringify(updates),
        });

        if (!res.ok) {
            throw new Error(`Failed to update worker run: ${res.status}`);
        }

        const body = (await res.json()) as { run?: WorkerRunData };
        if (!body.run) {
            throw new Error("Updated worker run payload missing");
        }

        return body.run;
    }

    async heartbeatWorkerRun(runId: string, heartbeat: WorkerRunHeartbeatInput = {}): Promise<WorkerRunData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/worker-runs/${runId}/heartbeat`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(heartbeat),
        });

        if (!res.ok) {
            throw new Error(`Failed to heartbeat worker run: ${res.status}`);
        }

        const body = (await res.json()) as { run?: WorkerRunData };
        if (!body.run) {
            throw new Error("Worker run heartbeat payload missing");
        }

        return body.run;
    }

    async finishWorkerTaskSession(input: WorkerTaskSessionFinishInput): Promise<WorkerRunData> {
        const run = await this.updateWorkerRun(input.runId, {
            status: input.outcome,
            percent:
                input.percent ??
                (input.outcome === "SUCCEEDED" ? 100 : undefined),
            currentStep:
                input.currentStep ??
                (input.outcome === "SUCCEEDED"
                    ? "Execution completed"
                    : input.outcome === "FAILED"
                        ? "Execution failed"
                        : "Execution cancelled"),
            summary: input.summary,
            metadata: input.metadata,
        });

        if (input.taskId && input.unwatchTask !== false) {
            this.unwatchTask(input.taskId);
        }

        return run;
    }

    async submitDeliveryForWorkerRun(
        input: WorkerRunSubmitDeliveryInput
    ): Promise<WorkerRunSubmitDeliveryResult> {
        const deliveryResult = await this.createTaskDelivery(input.taskId, {
            deliveryHash: input.deliveryHash,
            content: input.content ?? "Delivery submitted by worker session.",
            artifacts: input.artifacts,
            selfTestResults: input.selfTestResults,
            revisionChanges: input.revisionChanges,
            aiValidationResult: input.aiValidationResult,
            isPass: input.isPass,
        });

        const txHash = await this.submitDelivery(input.escrowId, input.deliveryHash);
        await this.attachDeliveryTxHash(input.taskId, deliveryResult.delivery.id, txHash);

        const run = await this.updateWorkerRun(input.runId, {
            status: "RUNNING",
            percent: input.percent ?? 100,
            currentStep: input.currentStep ?? "Delivery submitted, waiting for requester review",
            summary: input.summary ?? "Delivery submitted successfully and is now under requester review.",
            metadata: input.metadata,
        });

        return {
            txHash,
            deliveryId: deliveryResult.delivery.id,
            delivery: deliveryResult.delivery,
            run,
        };
    }

    async gateWorkerRunForApproval(
        input: WorkerApprovalGateInput
    ): Promise<WorkerApprovalGateResult> {
        const approval = await this.requestApproval({
            taskId: input.taskId,
            workerRunId: input.runId,
            kind: input.kind,
            title: input.title,
            summary: input.summary,
            payload: input.payload,
            dueAt: input.dueAt,
        });

        const run = await this.updateWorkerRun(input.runId, {
            status: "WAITING_APPROVAL",
            percent: input.percent,
            currentStep: input.currentStep ?? "Waiting for node-owner approval",
            summary: input.runSummary ?? input.summary ?? input.title,
            metadata: input.metadata,
        });

        return {
            run,
            approval,
        };
    }

    async executeWorkerRunAction(
        runId: string,
        action: WorkerRunAction,
        note?: string
    ): Promise<WorkerRunActionResult> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/worker-runs/${runId}/actions`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ action, note }),
        });

        if (!res.ok) {
            throw new Error(`Failed to execute worker run action: ${res.status}`);
        }

        const body = (await res.json()) as {
            action?: WorkerRunAction;
            run?: WorkerRunData;
            replacementRun?: WorkerRunData | null;
        };
        if (!body.action || !body.run) {
            throw new Error("Worker run action payload missing");
        }

        return {
            action: body.action,
            run: body.run,
            replacementRun: body.replacementRun ?? null,
        };
    }

    async resolveStaleWorkerRuns(
        input: ResolveStaleWorkerRunsInput
    ): Promise<ResolveStaleWorkerRunsResult> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/worker-runs/resolve-stale`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to resolve stale worker runs: ${res.status}`);
        }

        const body = (await res.json()) as {
            action?: Exclude<WorkerRunAction, "RETRY">;
            resolvedCount?: number;
            runs?: WorkerRunData[];
        };

        return {
            action: body.action ?? input.action,
            resolvedCount: body.resolvedCount ?? 0,
            runs: body.runs ?? [],
        };
    }

    async getApprovalRequests(options: {
        status?: ApprovalRequestStatus;
        taskId?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<ApprovalRequestData[]> {
        const params = new URLSearchParams();
        if (options.status) params.set("status", options.status);
        if (options.taskId) params.set("taskId", options.taskId);
        params.set("limit", String(options.limit ?? 20));
        params.set("offset", String(options.offset ?? 0));

        const res = await fetch(`${this.platformUrl}/api/nodes/me/approvals?${params.toString()}`, {
            headers: this.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch approval requests: ${res.status}`);
        }

        const body = (await res.json()) as { approvals?: ApprovalRequestData[] };
        return body.approvals ?? [];
    }

    async requestApproval(input: ApprovalRequestCreateInput): Promise<ApprovalRequestData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/approvals`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to create approval request: ${res.status}`);
        }

        const body = (await res.json()) as { approval?: ApprovalRequestData };
        if (!body.approval) {
            throw new Error("Approval request payload missing");
        }

        return body.approval;
    }

    async resolveApprovalRequest(
        approvalId: string,
        resolution: ApprovalRequestResolution
    ): Promise<ApprovalRequestData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/approvals/${approvalId}/resolve`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(resolution),
        });

        if (!res.ok) {
            throw new Error(`Failed to resolve approval request: ${res.status}`);
        }

        const body = (await res.json()) as { approval?: ApprovalRequestData };
        if (!body.approval) {
            throw new Error("Resolved approval payload missing");
        }

        return body.approval;
    }

    async waitForApprovalResolution(
        input: WaitForApprovalResolutionInput
    ): Promise<WaitForApprovalResolutionResult> {
        const waitResult = await this.waitForNodeEvent({
            events: ["NODE_APPROVAL_RESOLVED"],
            taskId: input.taskId,
            approvalId: input.approvalId,
            timeoutMs: input.timeoutMs,
            autoWatchTask: input.autoWatchTask,
        });

        if (waitResult.timedOut) {
            return {
                timedOut: true,
                matchedEvent: waitResult.matchedEvent,
                event: waitResult.data,
            };
        }

        const approvals = await this.getApprovalRequests({
            taskId: input.taskId,
            limit: 100,
            offset: 0,
        });
        const approval = approvals.find((item) => item.id === input.approvalId);
        if (!approval) {
            throw new Error(`Approval ${input.approvalId} was resolved but could not be reloaded`);
        }

        return {
            approval,
            timedOut: false,
            matchedEvent: waitResult.matchedEvent,
            event: waitResult.data,
        };
    }

    async resumeWorkerRunAfterApproval(
        input: ResumeWorkerRunAfterApprovalInput
    ): Promise<ResumeWorkerRunAfterApprovalResult> {
        const approvals = await this.getApprovalRequests({
            taskId: input.taskId,
            limit: 100,
            offset: 0,
        });
        const approval = approvals.find((item) => item.id === input.approvalId);
        if (!approval) {
            throw new Error(`Approval ${input.approvalId} not found for task ${input.taskId}`);
        }
        if (approval.status === "PENDING") {
            throw new Error(`Approval ${input.approvalId} is still pending`);
        }
        if (approval.status !== "APPROVED") {
            throw new Error(`Approval ${input.approvalId} resolved with status ${approval.status} and cannot resume the worker`);
        }

        const run = await this.updateWorkerRun(input.runId, {
            status: "RUNNING",
            percent: input.percent,
            currentStep: input.currentStep ?? "Owner approval resolved, execution resumed",
            summary: input.summary ?? approval.responseNote ?? approval.summary ?? approval.title,
            metadata: input.metadata,
        });

        return {
            run,
            approval,
        };
    }

    async waitForRequesterReviewOutcome(
        input: WaitForRequesterReviewOutcomeInput
    ): Promise<WaitForRequesterReviewOutcomeResult> {
        const waitResult = await this.waitForNodeEvent({
            events: ["TASK_ACCEPTED", "REVISION_REQUESTED", "TASK_SETTLED"],
            taskId: input.taskId,
            timeoutMs: input.timeoutMs,
            autoWatchTask: input.autoWatchTask,
        });

        const task = await this.fetchTaskDetails(input.taskId);
        if (waitResult.timedOut) {
            return {
                task,
                timedOut: true,
                matchedEvent: null,
                event: waitResult.data,
            };
        }

        const matchedEvent = waitResult.matchedEvent as
            | "TASK_ACCEPTED"
            | "REVISION_REQUESTED"
            | "TASK_SETTLED";
        let revisionDetails: unknown;

        if (matchedEvent === "REVISION_REQUESTED") {
            revisionDetails = await this.getRevisionDetails(input.taskId);
        }

        return {
            task,
            timedOut: false,
            matchedEvent,
            revisionDetails,
            event: waitResult.data,
        };
    }

    async syncWorkerRunWithRequesterReview(
        input: SyncWorkerRunWithRequesterReviewInput
    ): Promise<SyncWorkerRunWithRequesterReviewResult> {
        if (input.outcome === "REVISION_REQUESTED") {
            const run = await this.updateWorkerRun(input.runId, {
                status: "RUNNING",
                percent: input.percent,
                currentStep: input.currentStep ?? "Requester requested revision work",
                summary: input.summary ?? "Requester review requested another revision pass.",
                metadata: input.metadata,
            });

            return {
                run,
                outcome: input.outcome,
            };
        }

        const run = await this.updateWorkerRun(input.runId, {
            status: "SUCCEEDED",
            percent: input.percent ?? 100,
            currentStep:
                input.currentStep ??
                (input.outcome === "TASK_ACCEPTED"
                    ? "Requester accepted the delivery"
                    : "Task settled after requester review"),
            summary:
                input.summary ??
                (input.outcome === "TASK_ACCEPTED"
                    ? "Delivery accepted by the requester."
                    : "Task settled after requester review."),
            metadata: input.metadata,
        });

        return {
            run,
            outcome: input.outcome,
        };
    }

    async expireOverdueApprovals(
        input: ExpireOverdueApprovalsInput = {}
    ): Promise<ExpireOverdueApprovalsResult> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/approvals/expire-overdue`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to expire overdue approvals: ${res.status}`);
        }

        const body = (await res.json()) as {
            expiredCount?: number;
            approvals?: ApprovalRequestData[];
        };

        return {
            expiredCount: body.expiredCount ?? 0,
            approvals: body.approvals ?? [],
        };
    }

    async getNodeOpsOverview(): Promise<NodeOpsOverviewData> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/ops-overview`, {
            headers: this.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch node ops overview: ${res.status}`);
        }

        const body = (await res.json()) as { overview?: NodeOpsOverviewData };
        if (!body.overview) {
            throw new Error("Node ops overview payload missing");
        }

        return body.overview;
    }

    async executeTaskAction(taskId: string, action: TaskAction, note?: string): Promise<TaskActionResult> {
        const res = await fetch(`${this.platformUrl}/api/nodes/me/tasks/${taskId}/actions`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ action, note }),
        });

        if (!res.ok) {
            throw new Error(`Failed to execute task action: ${res.status}`);
        }

        const body = (await res.json()) as {
            action?: TaskAction;
            note?: string;
            task?: TaskActionResult["task"];
        };
        if (!body.action || !body.task) {
            throw new Error("Task action payload missing");
        }

        return {
            action: body.action,
            note: body.note,
            task: body.task,
        };
    }

    async getAvailableTasks(options: {
        limit?: number;
        offset?: number;
        status?: string;
    } = {}): Promise<TaskListItem[]> {
        const params = new URLSearchParams();
        params.set("limit", String(options.limit ?? 20));
        params.set("offset", String(options.offset ?? 0));
        if (options.status) params.set("status", options.status);

        const fetchFromPlatform = async () => {
            const res = await fetch(
                `${this.platformUrl}/api/tasks?${params}`,
                { headers: this.headers() }
            );

            if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
            const body = (await res.json()) as { data?: TaskListItem[]; tasks?: TaskListItem[] };
            return body.data || body.tasks || [];
        };

        try {
            return await fetchFromPlatform();
        } catch (platformError) {
            if (!this.platformConfig.envioUrl) {
                throw platformError;
            }

            return queryAvailableTasksFromEnvio(this.platformConfig, options);
        }
    }

    async getMyTasks(options: GetMyTasksOptions = {}): Promise<TaskListItem[]> {
        const currentUser = await this.getCurrentUser();
        const params = new URLSearchParams();
        params.set("providerId", currentUser.id);
        params.set("limit", String(options.limit ?? 20));
        params.set("offset", String(options.offset ?? 0));
        if (options.status) params.set("status", options.status);
        if (options.assignment) params.set("assignment", options.assignment);
        if (options.sortBy) params.set("sortBy", options.sortBy);

        const res = await fetch(`${this.platformUrl}/api/tasks?${params.toString()}`, {
            headers: this.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch provider tasks: ${res.status}`);
        }

        const body = (await res.json()) as { data?: TaskListItem[]; tasks?: TaskListItem[] };
        return body.data ?? body.tasks ?? [];
    }

    async bidOnTask(taskId: string, message?: string): Promise<unknown> {
        const res = await fetch(
            `${this.platformUrl}/api/matching/bid`,
            {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify({ taskId, message }),
            }
        );

        if (!res.ok) throw new Error(`Failed to bid: ${res.status}`);
        const body = (await res.json()) as { data?: unknown; task?: unknown };
        return body.data ?? body.task ?? body;
    }

    async rejectInvitation(taskId: string, reason?: string): Promise<void> {
        const res = await fetch(
            `${this.platformUrl}/api/matching/reject-invitation`,
            {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify({ taskId, reason }),
            }
        );

        if (!res.ok) throw new Error(`Failed to reject invitation: ${res.status}`);
    }

    async sendMessage(
        taskId: string,
        content: string,
        type: MessageType = "GENERAL"
    ): Promise<unknown> {
        return this.chat.sendMessage(taskId, content, type);
    }

    // ──── Built-in Deterministic Handlers ────────────────────────────

    /**
     * Handle events that require deterministic (non-LLM) processing.
     * These run BEFORE user-registered handlers.
     */
    async getClarifications(taskId: string): Promise<TaskClarification[]> {
        const result = await this.chat.getClarifications(taskId);
        return result.clarifications;
    }

    async getUnreadChatCount(taskId: string): Promise<number> {
        return this.chat.getUnreadCount(taskId);
    }

    async markChatRead(taskId: string, lastReadMessageId: string): Promise<void> {
        return this.chat.markRead(taskId, lastReadMessageId);
    }

    private handleBuiltInEvent(event: string, taskEvent: TaskEvent): void {
        switch (event) {
            case "ASSIGNMENT_SIGNATURE":
                this.cacheAssignmentSignature(taskEvent);
                if (this.autoClaimOnSignature) {
                    this.handleAssignmentSignature(taskEvent);
                }
                break;
        }
    }

    private cacheAssignmentSignature(event: TaskEvent): void {
        const data = event.data;
        const taskId = String(data.taskId ?? event.taskId ?? "");
        if (!taskId) {
            return;
        }

        const assignment: AssignmentSignatureData = {
            taskId,
            escrowId: BigInt(data.escrowId as string | number),
            nonce: BigInt(data.nonce as string | number),
            expiredAt: BigInt(data.expiredAt as string | number),
            signature: data.signature as `0x${string}`,
        };

        this.assignmentSignatures.set(taskId, assignment);
        console.error(`[Agent] Assignment signature cached for task ${taskId}`);
    }

    /**
     * Auto-claim task on-chain when platform delivers EIP-712 signature.
     * This is deterministic — no LLM involved, just contract call.
     */
    private handleAssignmentSignature(event: TaskEvent): void {
        const data = event.data;
        const taskId = String(data.taskId ?? event.taskId ?? "");

        if (!taskId) {
            console.error("[Agent] Missing taskId on ASSIGNMENT_SIGNATURE payload");
            return;
        }

        const claimParams: ClaimTaskParams = {
            escrowId: BigInt(data.escrowId as string | number),
            nonce: BigInt(data.nonce as string | number),
            expiredAt: BigInt(data.expiredAt as string | number),
            platformSignature: data.signature as `0x${string}`,
        };

        console.error(`[Agent] Assignment signature received for escrow ${claimParams.escrowId}`);
        console.error(`[Agent] Auto-claiming task on-chain...`);

        // Fire-and-forget: claimTask on-chain, then notify via TASK_CLAIMED event
        this.client
            .claimTask(claimParams)
            .then((txHash: any) => {
                this.assignmentSignatures.delete(taskId);
                console.error(`[Agent] claimTask() tx: ${txHash}`);
                console.error(`[Agent] Task claimed. Waiting for confidential materials (TASK_DETAILS)...`);

                // Dispatch internal event so user can track claim success
                this.dispatch("TASK_CLAIMED", {
                    type: "TASK_CLAIMED",
                    data: {
                        escrowId: claimParams.escrowId,
                        txHash,
                        taskId,
                    },
                });
            })
            .catch((err: any) => {
                console.error(`[Agent] claimTask() failed:`, err);
                this.dispatch("CLAIM_FAILED", {
                    type: "CLAIM_FAILED",
                    data: {
                        escrowId: claimParams.escrowId,
                        error: err instanceof Error ? err.message : String(err),
                        taskId,
                    },
                });
            });
    }

    // ──── Private ────────────────────────────────────────────────────

    private dispatch(event: string, data: TaskEvent): void {
        const handlers = this.handlers.get(event);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    const result = handler(data);
                    if (result instanceof Promise) {
                        result.catch((err) => {
                            console.error(`[Agent] Async handler error for "${event}":`, err);
                        });
                    }
                } catch (err) {
                    console.error(`[Agent] Handler error for "${event}":`, err);
                }
            }
        }
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.jwtToken}`,
            "Content-Type": "application/json",
        };
    }
}
