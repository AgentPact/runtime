/**
 * @agentpactai/runtime - Type definitions
 */

/** Category of the task */
export enum TaskCategory {
    SOFTWARE = "SOFTWARE",
    WRITING = "WRITING",
    VISUAL = "VISUAL",
    DATA = "DATA",
    MARKETING = "MARKETING",
    RESEARCH = "RESEARCH",
    SUPPORT = "SUPPORT",
    OTHER = "OTHER",
}

/** Task lifecycle states matching the on-chain enum */
export enum TaskState {
    Created = 0,
    ConfirmationPending = 1,
    Working = 2,
    Delivered = 3,
    InRevision = 4,
    Accepted = 5,
    Settled = 6,
    TimedOut = 7,
    Cancelled = 8,
}

/** Human-readable labels for TaskState */
export const TaskStateLabel: Record<TaskState, string> = {
    [TaskState.Created]: "Created",
    [TaskState.ConfirmationPending]: "Confirmation Pending",
    [TaskState.Working]: "Working",
    [TaskState.Delivered]: "Delivered",
    [TaskState.InRevision]: "In Revision",
    [TaskState.Accepted]: "Accepted",
    [TaskState.Settled]: "Settled",
    [TaskState.TimedOut]: "Timed Out",
    [TaskState.Cancelled]: "Cancelled",
};

/** On-chain EscrowRecord structure (mirrors Solidity struct) */
export interface EscrowRecord {
    requester: `0x${string}`;
    provider: `0x${string}`;
    rewardAmount: bigint;
    requesterDeposit: bigint;
    depositConsumed: bigint;
    token: `0x${string}`;
    state: TaskState;
    taskHash: `0x${string}`;
    latestDeliveryHash: `0x${string}`;
    latestCriteriaHash: `0x${string}`;
    /** Relative delivery duration in seconds (set by requester in createEscrow) */
    deliveryDurationSeconds: bigint;
    /** Absolute delivery deadline (set in confirmTask, extended on revision) */
    deliveryDeadline: bigint;
    acceptanceDeadline: bigint;
    confirmationDeadline: bigint;
    maxRevisions: number;
    currentRevision: number;
    /** Number of acceptance criteria (3-10) */
    criteriaCount: number;
    /** On-chain decline count (task suspends at 3) */
    declineCount: number;
    acceptanceWindowHours: number;
    /** Fund weights for criteria settlement (fetched separately) */
    fundWeights?: number[];
}

/** Parameters for creating an escrow */
export interface CreateEscrowParams {
    taskHash: `0x${string}`;
    /** Relative delivery duration in seconds (deadline set in confirmTask) */
    deliveryDurationSeconds: bigint;
    maxRevisions: number;
    acceptanceWindowHours: number;
    /** Number of acceptance criteria (3-10) */
    criteriaCount: number;
    /** Fund weight for each criterion (5-40% each, must sum to 100) */
    fundWeights: number[];
    /** address(0) = ETH, otherwise ERC20 token address */
    token: `0x${string}`;
    /** Total amount for ERC20 (ignored for ETH, msg.value used) */
    totalAmount: bigint;
}

/** Parameters for requesting a revision */
export interface RequestRevisionParams {
    escrowId: bigint;
    reasonHash: `0x${string}`;
    /** Per-criterion pass(true)/fail(false) — passRate computed on-chain */
    criteriaResults: boolean[];
}

/** Parameters for claiming a task */
export interface ClaimTaskParams {
    escrowId: bigint;
    nonce: bigint;
    expiredAt: bigint;
    platformSignature: `0x${string}`;
}

/** EIP-712 assignment data for platform signing */
export interface TaskAssignmentData {
    escrowId: bigint;
    agent: `0x${string}`;
    nonce: bigint;
    expiredAt: bigint;
}

/** Chain configuration (can be built from PlatformConfig) */
export interface ChainConfig {
    chainId: number;
    rpcUrl: string;
    escrowAddress: `0x${string}`;
    tipJarAddress: `0x${string}`;
    usdcAddress: `0x${string}`;
    explorerUrl: string;
}

/**
 * Platform configuration — combines hardcoded constants with runtime values.
 * Critical fields (addresses, chainId) are hardcoded in constants.ts for security.
 * Optional fields (platformFeeBps, etc.) are only available from /api/config.
 */
export interface PlatformConfig {
    chainId: number;
    escrowAddress: `0x${string}`;
    tipJarAddress: `0x${string}`;
    usdcAddress: `0x${string}`;
    rpcUrl: string;
    wsUrl: string;
    explorerUrl: string;
    /** Platform base URL */
    platformUrl?: string;
    /** Optional Envio GraphQL endpoint */
    envioUrl?: string;
    /** Current platform chain sync mode */
    chainSyncMode?: "envio" | "rpc";
    /** Only available from /api/config */
    platformFeeBps?: number;
    /** Only available from /api/config */
    minPassRate?: number;
    /** Only available from /api/config */
    version?: string;
}

export interface TokenBalanceInfo {
    tokenAddress: `0x${string}`;
    symbol: string;
    decimals: number;
    raw: bigint;
    formatted: string;
}

export interface AgentWalletOverview {
    chainId: number;
    walletAddress: `0x${string}`;
    nativeTokenSymbol: "ETH";
    nativeBalanceWei: bigint;
    nativeBalanceEth: string;
    usdc: TokenBalanceInfo;
}

export type GasQuoteAction =
    | "approve_token"
    | "confirm_task"
    | "decline_task"
    | "submit_delivery"
    | "abandon_task"
    | "claim_acceptance_timeout"
    | "claim_delivery_timeout"
    | "claim_confirmation_timeout";

export interface GasQuoteRequest {
    action: GasQuoteAction;
    tokenAddress?: `0x${string}`;
    spender?: `0x${string}`;
    amount?: bigint;
    escrowId?: bigint;
    deliveryHash?: `0x${string}`;
}

export interface GasQuoteSummary {
    action: GasQuoteAction;
    chainId: number;
    walletAddress: `0x${string}`;
    target: `0x${string}`;
    feeModel: "legacy" | "eip1559";
    gasEstimate: bigint;
    gasLimitSuggested: bigint;
    gasPriceWei?: bigint;
    maxFeePerGasWei?: bigint;
    maxPriorityFeePerGasWei?: bigint;
    estimatedTotalCostWei: bigint;
    estimatedTotalCostEth: string;
}

export interface PreflightCheckRequest {
    action?: GasQuoteAction;
    tokenAddress?: `0x${string}`;
    spender?: `0x${string}`;
    requiredAmount?: bigint;
    escrowId?: bigint;
    deliveryHash?: `0x${string}`;
    minNativeBalanceWei?: bigint;
}

export interface PreflightAllowanceInfo {
    tokenAddress: `0x${string}`;
    spender: `0x${string}`;
    raw: bigint;
    formatted: string;
    requiredRaw?: bigint;
    requiredFormatted?: string;
    sufficient?: boolean;
}

export interface PreflightCheckResult {
    action?: GasQuoteAction;
    chainId: number;
    expectedChainId: number;
    walletAddress: `0x${string}`;
    chainOk: boolean;
    nativeBalanceWei: bigint;
    nativeBalanceEth: string;
    minNativeBalanceWei?: bigint;
    gasQuote?: GasQuoteSummary;
    gasBalanceOk?: boolean;
    token?: TokenBalanceInfo;
    tokenBalanceOk?: boolean;
    allowance?: PreflightAllowanceInfo;
    canProceed: boolean;
    blockingReasons: string[];
    notes: string[];
}

export interface TransactionReceiptSummary {
    transactionHash: `0x${string}`;
    status: "success" | "reverted";
    blockNumber: bigint;
    gasUsed: bigint;
    effectiveGasPrice?: bigint;
    explorerUrl?: string;
}

export interface TransactionStatusSummary {
    transactionHash: `0x${string}`;
    status: "pending" | "success" | "reverted" | "not_found";
    found: boolean;
    confirmations: number;
    blockNumber?: bigint;
    gasUsed?: bigint;
    effectiveGasPrice?: bigint;
    explorerUrl?: string;
}

export interface TaskTimelineItem {
    id: string;
    taskId: string;
    escrowId?: string | null;
    eventName: string;
    txHash?: string | null;
    blockNumber?: string | null;
    logIndex?: number | null;
    timestamp?: string | null;
    actor?: string | null;
    data?: unknown;
}

export interface TaskChainProjection {
    escrowId?: string | null;
    taskHash?: string | null;
    requester?: string | null;
    provider?: string | null;
    token?: string | null;
    rewardAmount?: string | null;
    requesterDeposit?: string | null;
    providerPayout?: string | null;
    platformFee?: string | null;
    requesterRefund?: string | null;
    compensation?: string | null;
    currentRevision?: number | null;
    maxRevisions?: number | null;
    acceptanceWindowHours?: number | null;
    criteriaCount?: number | null;
    declineCount?: number | null;
    passRate?: number | null;
    confirmationDeadline?: string | null;
    deliveryDeadline?: string | null;
    acceptanceDeadline?: string | null;
    lastEventName?: string | null;
    lastUpdatedBlock?: string | null;
    lastUpdatedAt?: string | null;
}

export interface TaskParticipantSummary {
    id?: string;
    name?: string | null;
    walletAddress?: string | null;
    avatarUrl?: string | null;
}

export interface TaskAttachmentSummary {
    id: string;
    type: string;
    fileName: string;
    mimeType?: string | null;
    description?: string | null;
    attachmentId?: string;
}

export interface TaskListItem {
    id: string;
    escrowId?: string | null;
    taskHash?: string | null;
    title?: string;
    description?: string;
    category?: string;
    difficulty?: string;
    urgency?: string;
    tags?: string[];
    rewardAmount?: string;
    tokenAddress?: string;
    deliveryDurationSeconds?: number;
    acceptanceWindowHrs?: number;
    maxRevisions?: number;
    criteriaCount?: number;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    requester?: TaskParticipantSummary;
    provider?: TaskParticipantSummary | null;
    attachments?: TaskAttachmentSummary[];
    chainProjection?: TaskChainProjection | null;
    chainProjectionSource?: "platform" | "envio";
}

export interface TaskDetailsData {
    taskId: string;
    escrowId?: string | null;
    title?: string;
    description?: string;
    status?: string;
    requirements: Record<string, unknown>;
    confirmationDoc?: {
        id: string;
        aiSummary: string;
        acceptanceCriteria: unknown;
        wizardData: unknown;
        confirmedHash?: string | null;
    } | null;
    publicMaterials: TaskAttachmentSummary[];
    confidentialMaterials: TaskAttachmentSummary[];
    confirmDeadline: number;
    chainProjection?: TaskChainProjection | null;
    chainProjectionSource?: "platform" | "envio";
}
