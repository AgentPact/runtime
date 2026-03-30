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
import { TaskChatClient, type MessageType } from "./chat/taskChat.js";
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
     * Default: true (deterministic, no LLM needed)
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

export interface AgentNotification {
    id: string;
    userId: string;
    event: string;
    data: Record<string, unknown> | null;
    readAt: string | null;
    createdAt: string;
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
        const nativeBalanceWei = await this.getNativeBalance();
        const usdcAddress = this.platformConfig.usdcAddress;
        const [usdcRaw, usdcDecimals, usdcSymbol] = await Promise.all([
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
        console.log(`[Agent] Token approval submitted on-chain: ${txHash}`);
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
        const chainId = await this.client.getChainId();
        const wallet = await this.getWalletOverview();

        const chainOk = chainId === this.platformConfig.chainId;
        if (!chainOk) {
            blockingReasons.push(
                `Connected chainId ${chainId} does not match expected chainId ${this.platformConfig.chainId}`
            );
        }

        let gasQuote: GasQuoteSummary | undefined;
        if (params.action) {
            gasQuote = await this.getGasQuote({
                action: params.action,
                tokenAddress: params.tokenAddress,
                spender: params.spender,
                requiredAmount: undefined,
                amount: params.requiredAmount,
                escrowId: params.escrowId,
                deliveryHash: params.deliveryHash,
            } as GasQuoteRequest & { requiredAmount?: bigint });
        } else {
            notes.push("No action-specific gas quote requested.");
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

        let token: TokenBalanceInfo | undefined;
        let tokenBalanceOk: boolean | undefined;
        if (params.tokenAddress) {
            token = await this.getTokenBalanceInfo(params.tokenAddress);
            if (params.requiredAmount !== undefined) {
                tokenBalanceOk = token.raw >= params.requiredAmount;
                if (!tokenBalanceOk) {
                    blockingReasons.push(
                        `Token balance ${token.formatted} ${token.symbol} is below the required amount`
                    );
                }
            }
        }

        let allowance: PreflightCheckResult["allowance"];
        if (params.tokenAddress && params.spender) {
            const allowanceRaw = await this.getTokenAllowance(params.tokenAddress, params.spender);
            const decimals = token?.decimals ?? await this.client.getTokenDecimals(params.tokenAddress);
            allowance = {
                tokenAddress: params.tokenAddress,
                spender: params.spender,
                raw: allowanceRaw,
                formatted: formatUnits(allowanceRaw, decimals),
            };

            if (params.requiredAmount !== undefined) {
                allowance.requiredRaw = params.requiredAmount;
                allowance.requiredFormatted = formatUnits(params.requiredAmount, decimals);
                allowance.sufficient = allowanceRaw >= params.requiredAmount;
                if (!allowance.sufficient) {
                    blockingReasons.push(
                        `Allowance ${allowance.formatted} is below the required amount ${allowance.requiredFormatted}`
                    );
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
     * Only available after claimTask() has been called on-chain.
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
