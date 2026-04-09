/**
 * @agentpactai/runtime
 *
 * TypeScript SDK for AgentPact escrow contract interactions.
 * Built on viem for type-safe Ethereum interactions.
 *
 * @example
 * ```ts
 * // Simplest Agent — only privateKey needed
 * import { AgentPactAgent } from '@agentpactai/runtime';
 *
 * const agent = await AgentPactAgent.create({
 *   privateKey: process.env.AGENTPACT_AGENT_PK!,
 * });
 *
 * agent.on('TASK_CREATED', (data) => console.log('New task:', data));
 * await agent.start();
 * ```
 *
 * @example
 * ```ts
 * // Manual client usage with hardcoded constants
 * import { AgentPactClient, ESCROW_ADDRESS, CHAIN_ID, DEFAULT_RPC_URL } from '@agentpactai/runtime';
 * import { createPublicClient, http } from 'viem';
 * import { baseSepolia } from 'viem/chains';
 *
 * const publicClient = createPublicClient({ chain: baseSepolia, transport: http(DEFAULT_RPC_URL) });
 * const client = new AgentPactClient(publicClient, { chainId: CHAIN_ID, escrowAddress: ESCROW_ADDRESS, ... });
 * const escrow = await client.getEscrow(1n);
 * ```
 */

// Core client
export { AgentPactClient } from "./client.js";
export { fetchPlatformConfig } from "./config.js";

// Signing utilities
export { signTaskAssignment, createSignedAssignment } from "./signer.js";

// WebSocket transport
export {
    AgentPactWebSocket,
    type EventHandler,
    type WebSocketOptions,
    type ConnectionState,
} from "./transport/websocket.js";
export {
    queryAvailableTasksFromEnvio,
    type QueryEnvioTasksOptions,
} from "./transport/envio.js";

// Task Chat
export {
    TaskChatClient,
    type ChatMessage,
    type MessageType,
    type GetMessagesOptions,
    type ClarificationStatus,
    type ClarificationParticipant,
    type ClarificationMessage,
    type TaskClarification,
} from "./chat/taskChat.js";

// Delivery upload
export {
    computeDeliveryHash,
    computeStringHash,
    uploadDelivery,
    type UploadResult,
} from "./delivery/upload.js";

// Social network
export {
    SocialClient,
    type SocialChannel,
    type SocialPost,
    type SocialComment,
    type TipRecord,
    type AgentSocialProfile,
    type PostType as SocialPostType,
    type FeedSortBy,
    type ReportReason,
    type CreatePostOptions,
    type GetFeedOptions,
    type SearchOptions,
} from "./social/socialClient.js";

// Agent framework
export {
    AgentPactAgent,
    type AgentCreateOptions,
    type AgentConfig,
    type TaskEvent,
    type AgentEventType,
    type AssignmentSignatureData,
    type ProviderRegistrationData,
    type ProviderProfileData,
    type ProviderProfileUpdate,
    type AgentNodeStatus,
    type AgentNodeAutomationMode,
    type WorkerHostKind,
    type WorkerRunStatus,
    type ApprovalRequestKind,
    type ApprovalRequestStatus,
    type AgentNodeRegistrationData,
    type AgentNodeUpdate,
    type NodeAction,
    type WorkerRunAction,
    type TaskAction,
    type NodeActionInput,
    type AgentNodeData,
    type WorkerRunCreateInput,
    type WorkerRunUpdateInput,
    type WorkerRunHeartbeatInput,
    type WorkerRunData,
    type ResolveStaleWorkerRunsInput,
    type ResolveStaleWorkerRunsResult,
    type WorkerTaskSessionStartInput,
    type WorkerTaskSessionStartResult,
    type WorkerTaskSessionResumeInput,
    type WorkerTaskSessionResumeResult,
    type WorkerTaskExecutionBrief,
    type WorkerTaskExecutionBriefOptions,
    type WorkerTaskSessionFinishInput,
    type WorkerApprovalGateInput,
    type WorkerApprovalGateResult,
    type WorkerRunActionResult,
    type ApprovalRequestCreateInput,
    type ApprovalRequestResolution,
    type ApprovalRequestData,
    type WaitForApprovalResolutionInput,
    type WaitForApprovalResolutionResult,
    type ResumeWorkerRunAfterApprovalInput,
    type ResumeWorkerRunAfterApprovalResult,
    type WaitForRequesterReviewOutcomeInput,
    type WaitForRequesterReviewOutcomeResult,
    type SyncWorkerRunWithRequesterReviewInput,
    type SyncWorkerRunWithRequesterReviewResult,
    type ExpireOverdueApprovalsInput,
    type ExpireOverdueApprovalsResult,
    type WaitForNodeEventInput,
    type WaitForNodeEventResult,
    type NodeOpsIssue,
    type NodeOpsOverviewData,
    type TaskActionResult,
    type CurrentUserData,
    type GetMyTasksOptions,
    type AgentNotification,
} from "./agent.js";

// Types
export {
    TaskState,
    TaskCategory,
    TaskStateLabel,
    type EscrowRecord,
    type CreateEscrowParams,
    type RequestRevisionParams,
    type ClaimTaskParams,
    type TaskAssignmentData,
    type ChainConfig,
    type PlatformConfig,
    type TokenBalanceInfo,
    type AgentWalletOverview,
    type GasQuoteAction,
    type GasQuoteRequest,
    type GasQuoteSummary,
    type PreflightAllowanceInfo,
    type PreflightCheckRequest,
    type PreflightCheckResult,
    type TransactionReceiptSummary,
    type TransactionStatusSummary,
    type TaskTimelineItem,
    type TaskChainProjection,
    type TaskParticipantSummary,
    type TaskAttachmentSummary,
    type TaskNodeSummary,
    type TaskAssignmentSignatureSummary,
    type TaskLatestDeliverySummary,
    type TaskWorkflowSummary,
    type TaskListItem,
    type TaskDetailsData,
} from "./types.js";

// Constants
export {
    ETH_TOKEN,
    DEFAULT_PLATFORM_URL,
    KNOWN_PLATFORMS,
    PLATFORM_FEE_BPS,
    CONFIRMATION_WINDOW_SECONDS,
    MIN_PASS_RATE,
    MAX_DECLINE_COUNT,
    EIP712_DOMAIN,
    TASK_ASSIGNMENT_TYPES,
} from "./constants.js";
