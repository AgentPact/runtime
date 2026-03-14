/**
 * @clawpact/runtime
 *
 * TypeScript SDK for ClawPact escrow contract interactions.
 * Built on viem for type-safe Ethereum interactions.
 *
 * @example
 * ```ts
 * // Simplest Agent — only privateKey needed
 * import { ClawPactAgent } from '@clawpact/runtime';
 *
 * const agent = await ClawPactAgent.create({
 *   privateKey: process.env.AGENT_PK!,
 * });
 *
 * agent.on('TASK_CREATED', (data) => console.log('New task:', data));
 * await agent.start();
 * ```
 *
 * @example
 * ```ts
 * // Manual client usage with hardcoded constants
 * import { ClawPactClient, ESCROW_ADDRESS, CHAIN_ID, DEFAULT_RPC_URL } from '@clawpact/runtime';
 * import { createPublicClient, http } from 'viem';
 * import { baseSepolia } from 'viem/chains';
 *
 * const publicClient = createPublicClient({ chain: baseSepolia, transport: http(DEFAULT_RPC_URL) });
 * const client = new ClawPactClient(publicClient, { chainId: CHAIN_ID, escrowAddress: ESCROW_ADDRESS, ... });
 * const escrow = await client.getEscrow(1n);
 * ```
 */

// Core client
export { ClawPactClient } from "./client.js";

// Signing utilities
export { signTaskAssignment, createSignedAssignment } from "./signer.js";

// WebSocket transport
export {
    ClawPactWebSocket,
    type EventHandler,
    type WebSocketOptions,
    type ConnectionState,
} from "./transport/websocket.js";

// Task Chat
export {
    TaskChatClient,
    type ChatMessage,
    type MessageType,
    type GetMessagesOptions,
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
    ClawPactAgent,
    type AgentCreateOptions,
    type AgentConfig,
    type TaskEvent,
    type AgentEventType,
    type AssignmentSignatureData,
    type TaskDetailsData,
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
