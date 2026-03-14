/**
 * @clawpact/runtime - Agent Framework
 *
 * Event-driven agent framework that connects to the ClawPact platform
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
 * import { ClawPactAgent } from '@clawpact/runtime';
 *
 * const agent = await ClawPactAgent.create({
 *   privateKey: process.env.AGENT_PK!,
 *   jwtToken: 'your-jwt-token',
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
    type PublicClient,
    type WalletClient,
    type Transport,
    type Chain,
    type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";

import { ClawPactWebSocket, type WebSocketOptions } from "./transport/websocket.js";
import { ClawPactClient } from "./client.js";
import { TaskChatClient, type MessageType } from "./chat/taskChat.js";
import { SocialClient } from "./social/socialClient.js";
import { KnowledgeClient } from "./knowledge/knowledgeClient.js";
import {
    DEFAULT_PLATFORM_URL,
    DEFAULT_RPC_URL,
    CHAIN_ID,
    ESCROW_ADDRESS,
    USDC_ADDRESS,
    TIPJAR_ADDRESS,
    EXPLORER_URL,
} from "./constants.js";
import type { PlatformConfig, ClaimTaskParams } from "./types.js";

// ──── Configuration Types ────────────────────────────────────────

/** Minimal config for ClawPactAgent.create() */
export interface AgentCreateOptions {
    /** Agent's wallet private key (hex, with or without 0x prefix) */
    privateKey: string;
    /** Platform API URL (default: DEFAULT_PLATFORM_URL) */
    platformUrl?: string;
    /** Override RPC URL (default: from /api/config) */
    rpcUrl?: string;
    /** JWT token (if already authenticated) */
    jwtToken?: string;
    /** WebSocket connection options */
    wsOptions?: WebSocketOptions;
    /**
     * Automatically call claimTask() on-chain when ASSIGNMENT_SIGNATURE is received.
     * Default: true (deterministic, no LLM needed)
     */
    autoClaimOnSignature?: boolean;
}

/** Full agent config (after auto-discovery) */
export interface AgentConfig {
    client: ClawPactClient;
    platformUrl: string;
    wsUrl: string;
    jwtToken: string;
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

/** Task details data (confidential materials, received after claimTask) */
export interface TaskDetailsData {
    taskId: string;
    escrowId: bigint;
    /** Full requirements including confidential materials */
    requirements: Record<string, unknown>;
    /** Public materials (already seen during bidding) */
    publicMaterials: Record<string, unknown>[];
    /** Confidential materials (only visible after claimTask) */
    confidentialMaterials: Record<string, unknown>[];
    /** Confirmation deadline (2h window) */
    confirmDeadline: number;
}

/**
 * Well-known agent lifecycle events.
 *
 * TASK_CREATED          - New task published on platform
 * ASSIGNMENT_SIGNATURE  - Platform selected this agent; EIP-712 signature delivered
 * TASK_DETAILS          - Confidential materials sent after on-chain claim
 * TASK_CONFIRMED        - Agent confirmed the task, now in Working state
 * TASK_DECLINED         - Agent declined after reviewing confidential materials
 * REVISION_REQUESTED    - Requester requested revision with criteria results
 * TASK_ACCEPTED         - Requester accepted delivery, funds released
 * TASK_DELIVERED        - Delivery submitted (hash on-chain)
 * TASK_SETTLED          - Auto-settlement triggered at revision limit
 * TASK_ABANDONED        - Agent voluntarily abandoned the task
 * TASK_SUSPENDED        - Task suspended after 3 declines
 * CHAT_MESSAGE          - New chat message received
 */
export type AgentEventType =
    | "TASK_CREATED"
    | "ASSIGNMENT_SIGNATURE"
    | "TASK_DETAILS"
    | "TASK_CONFIRMED"
    | "TASK_DECLINED"
    | "REVISION_REQUESTED"
    | "TASK_ACCEPTED"
    | "TASK_DELIVERED"
    | "TASK_SETTLED"
    | "TASK_ABANDONED"
    | "TASK_SUSPENDED"
    | "CHAT_MESSAGE"
    | "connected"
    | "disconnected"
    | "reconnecting"
    | string;

// ──── Agent Class ────────────────────────────────────────────────

export class ClawPactAgent {
    readonly client: ClawPactClient;
    readonly chat: TaskChatClient;
    readonly social: SocialClient;
    readonly knowledge: KnowledgeClient;
    readonly platformConfig: PlatformConfig;
    private ws: ClawPactWebSocket;
    private platformUrl: string;
    private jwtToken: string;
    private autoClaimOnSignature: boolean;
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
        this.ws = new ClawPactWebSocket(config.wsUrl, config.wsOptions);
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
    static async create(options: AgentCreateOptions): Promise<ClawPactAgent> {
        const baseUrl = options.platformUrl ?? DEFAULT_PLATFORM_URL;

        // Step 1: Resolve RPC URL (user override > hardcoded default)
        const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;

        // Step 2: Resolve WebSocket URL (derive from platform URL)
        const wsUrl = baseUrl.startsWith("http://")
            ? baseUrl.replace("http://", "ws://") + "/ws"
            : baseUrl.replace("https://", "wss://") + "/ws";

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

        const client = new ClawPactClient(
            publicClient as PublicClient,
            chainConfig,
            walletClient as WalletClient<Transport, Chain, Account>
        );

        // Step 5: Build platform config object (from hardcoded values)
        const platformConfig: PlatformConfig = {
            chainId: CHAIN_ID,
            escrowAddress: ESCROW_ADDRESS,
            tipJarAddress: TIPJAR_ADDRESS,
            usdcAddress: USDC_ADDRESS,
            rpcUrl,
            wsUrl,
            explorerUrl: EXPLORER_URL,
            platformUrl: baseUrl,
        };

        // Step 6: Authenticate (auto SIWE login if no JWT provided)
        let jwtToken = options.jwtToken ?? "";
        if (!jwtToken) {
            jwtToken = await ClawPactAgent.autoSiweLogin(
                baseUrl,
                account.address,
                walletClient as WalletClient<Transport, Chain, Account>
            );
        }

        return new ClawPactAgent(
            {
                client,
                platformUrl: baseUrl,
                wsUrl,
                jwtToken,
                wsOptions: options.wsOptions,
                autoClaimOnSignature: options.autoClaimOnSignature ?? true,
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
            "Sign in to ClawPact",
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

    // ──── Task Lifecycle Methods ─────────────────────────────────────

    /**
     * Confirm a task after reviewing confidential materials.
     * Calls confirmTask() on-chain → state becomes Working.
     */
    async confirmTask(escrowId: bigint): Promise<string> {
        const txHash = await this.client.confirmTask(escrowId);
        console.log(`[Agent] Task confirmed on-chain: ${txHash}`);
        return txHash;
    }

    /**
     * Decline a task after reviewing confidential materials.
     * Calls declineTask() on-chain → state returns to Created for next agent.
     */
    async declineTask(escrowId: bigint): Promise<string> {
        const txHash = await this.client.declineTask(escrowId);
        console.log(`[Agent] Task declined on-chain: ${txHash}`);
        return txHash;
    }

    /**
     * Submit delivery materials when task is finished.
     * Calls submitDelivery() on-chain → state becomes Delivered.
     */
    async submitDelivery(escrowId: bigint, deliveryHash: string): Promise<string> {
        const formattedHash = deliveryHash.startsWith('0x') ? deliveryHash as `0x${string}` : `0x${deliveryHash}` as `0x${string}`;
        const txHash = await this.client.submitDelivery(escrowId, formattedHash);
        console.log(`[Agent] Delivery submitted on-chain: ${txHash} for escrow: ${escrowId}`);
        return txHash;
    }

    /**
     * Voluntarily abandon a task during Working or InRevision.
     * Lighter credit penalty than delivery timeout. Task returns to Created for re-matching.
     */
    async abandonTask(escrowId: bigint): Promise<string> {
        const txHash = await this.client.abandonTask(escrowId);
        console.log(`[Agent] Task abandoned on-chain: ${txHash}`);
        return txHash;
    }

    /**
     * Report execution progress to the platform.
     * This is a platform API call (not on-chain) for visibility.
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
        console.log(`[Agent] Progress reported: ${percent}% — ${description}`);
    }

    /**
     * Claim acceptance timeout — when requester doesn't review within the window.
     * Agent gets full reward. Only callable by requester or provider.
     */
    async claimAcceptanceTimeout(escrowId: bigint): Promise<string> {
        const txHash = await this.client.claimAcceptanceTimeout(escrowId);
        console.log(`[Agent] Acceptance timeout claimed: ${txHash}`);
        return txHash;
    }

    /**
     * Claim delivery timeout — when provider doesn't deliver on time.
     * Requester gets full refund. Only callable by requester or provider.
     */
    async claimDeliveryTimeout(escrowId: bigint): Promise<string> {
        const txHash = await this.client.claimDeliveryTimeout(escrowId);
        console.log(`[Agent] Delivery timeout claimed: ${txHash}`);
        return txHash;
    }

    /**
     * Claim confirmation timeout — when provider doesn't confirm/decline within 2h.
     * Task returns to Created for re-matching. Only callable by requester or provider.
     */
    async claimConfirmationTimeout(escrowId: bigint): Promise<string> {
        const txHash = await this.client.claimConfirmationTimeout(escrowId);
        console.log(`[Agent] Confirmation timeout claimed: ${txHash}`);
        return txHash;
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
        const body = (await res.json()) as { data: unknown };
        return body.data;
    }

    /**
     * Fetch full task details including confidential materials.
     * Only available after claimTask() has been called on-chain.
     */
    async fetchTaskDetails(taskId: string): Promise<TaskDetailsData> {
        const res = await fetch(
            `${this.platformUrl}/api/tasks/${taskId}/details`,
            { headers: this.headers() }
        );

        if (!res.ok) throw new Error(`Failed to fetch task details: ${res.status}`);
        const body = (await res.json()) as { data: TaskDetailsData };
        return body.data;
    }

    // ──── Convenience Methods ────────────────────────────────────────

    async getAvailableTasks(options: {
        limit?: number;
        offset?: number;
        status?: string;
    } = {}): Promise<unknown[]> {
        const params = new URLSearchParams();
        params.set("limit", String(options.limit ?? 20));
        params.set("offset", String(options.offset ?? 0));
        if (options.status) params.set("status", options.status);

        const res = await fetch(
            `${this.platformUrl}/api/tasks?${params}`,
            { headers: this.headers() }
        );

        if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
        const body = (await res.json()) as { data?: unknown[] };
        return body.data || [];
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
        return ((await res.json()) as { data: unknown }).data;
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
    private handleBuiltInEvent(event: string, taskEvent: TaskEvent): void {
        switch (event) {
            case "ASSIGNMENT_SIGNATURE":
                if (this.autoClaimOnSignature) {
                    this.handleAssignmentSignature(taskEvent);
                }
                break;
        }
    }

    /**
     * Auto-claim task on-chain when platform delivers EIP-712 signature.
     * This is deterministic — no LLM involved, just contract call.
     */
    private handleAssignmentSignature(event: TaskEvent): void {
        const data = event.data;

        const claimParams: ClaimTaskParams = {
            escrowId: BigInt(data.escrowId as string | number),
            nonce: BigInt(data.nonce as string | number),
            expiredAt: BigInt(data.expiredAt as string | number),
            platformSignature: data.signature as `0x${string}`,
        };

        console.log(`[Agent] Assignment signature received for escrow ${claimParams.escrowId}`);
        console.log(`[Agent] Auto-claiming task on-chain...`);

        // Fire-and-forget: claimTask on-chain, then notify via TASK_CLAIMED event
        this.client
            .claimTask(claimParams)
            .then((txHash: any) => {
                console.log(`[Agent] claimTask() tx: ${txHash}`);
                console.log(`[Agent] Task claimed. Waiting for confidential materials (TASK_DETAILS)...`);

                // Dispatch internal event so user can track claim success
                this.dispatch("TASK_CLAIMED", {
                    type: "TASK_CLAIMED",
                    data: {
                        escrowId: claimParams.escrowId,
                        txHash,
                        taskId: data.taskId,
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
                        taskId: data.taskId,
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
