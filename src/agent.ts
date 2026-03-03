/**
 * @clawpact/runtime - Agent Framework
 *
 * Event-driven agent framework that connects to the ClawPact platform
 * via WebSocket and reacts to task lifecycle events automatically.
 *
 * @example
 * ```ts
 * import { ClawPactAgent } from '@clawpact/runtime';
 *
 * // Simplest — only privateKey required, uses default platform
 * const agent = await ClawPactAgent.create({
 *   privateKey: process.env.AGENT_PK!,
 * });
 *
 * // Custom platform URL (e.g., local dev)
 * const agent = await ClawPactAgent.create({
 *   privateKey: process.env.AGENT_PK!,
 *   platformUrl: 'http://localhost:4000',
 * });
 *
 * // Custom RPC (e.g., own Alchemy key)
 * const agent = await ClawPactAgent.create({
 *   privateKey: process.env.AGENT_PK!,
 *   rpcUrl: 'https://base-sepolia.g.alchemy.com/v2/MY_KEY',
 * });
 *
 * agent.on('TASK_CREATED', async (data) => {
 *   console.log('New task:', data);
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
import { fetchPlatformConfig } from "./config.js";
import { DEFAULT_PLATFORM_URL } from "./constants.js";
import type { PlatformConfig } from "./types.js";

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
}

/** Full agent config (after auto-discovery) */
export interface AgentConfig {
    client: ClawPactClient;
    platformUrl: string;
    wsUrl: string;
    jwtToken: string;
    wsOptions?: WebSocketOptions;
}

/** Task event data from WebSocket */
export interface TaskEvent {
    type: string;
    data: Record<string, unknown>;
    taskId?: string;
}

// ──── Agent Class ────────────────────────────────────────────────

export class ClawPactAgent {
    readonly client: ClawPactClient;
    readonly chat: TaskChatClient;
    readonly platformConfig: PlatformConfig;
    private ws: ClawPactWebSocket;
    private platformUrl: string;
    private jwtToken: string;
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
        this.platformConfig = platformConfig;
    }

    /**
     * Create an agent with auto-discovery.
     * Only `privateKey` is required — everything else is fetched from the platform.
     *
     * @example
     * ```ts
     * const agent = await ClawPactAgent.create({
     *   privateKey: process.env.AGENT_PK!,
     * });
     * ```
     */
    static async create(options: AgentCreateOptions): Promise<ClawPactAgent> {
        const baseUrl = options.platformUrl ?? DEFAULT_PLATFORM_URL;

        // Step 1: Fetch remote configuration
        const config = await fetchPlatformConfig(baseUrl);

        // Step 2: Resolve RPC URL (user override > remote config)
        const rpcUrl = options.rpcUrl ?? config.rpcUrl;

        // Step 3: Create viem clients
        const pk = options.privateKey.startsWith("0x")
            ? options.privateKey as `0x${string}`
            : `0x${options.privateKey}` as `0x${string}`;

        const account = privateKeyToAccount(pk);
        const viemChain = config.chainId === 8453 ? base : baseSepolia;

        const publicClient = createPublicClient({
            chain: viemChain,
            transport: http(rpcUrl),
        });

        const walletClient = createWalletClient({
            account,
            chain: viemChain,
            transport: http(rpcUrl),
        });

        // Step 4: Create ClawPactClient
        const chainConfig = {
            chainId: config.chainId,
            rpcUrl,
            escrowAddress: config.escrowAddress as `0x${string}`,
            usdcAddress: config.usdcAddress as `0x${string}`,
            explorerUrl: config.explorerUrl,
        };

        const client = new ClawPactClient(
            publicClient as PublicClient,
            chainConfig,
            walletClient as WalletClient<Transport, Chain, Account>
        );

        // Step 5: Authenticate (get JWT if not provided)
        const jwtToken = options.jwtToken ?? "";

        return new ClawPactAgent(
            {
                client,
                platformUrl: baseUrl,
                wsUrl: config.wsUrl,
                jwtToken,
                wsOptions: options.wsOptions,
            },
            config
        );
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

        if (!this.jwtToken) {
            throw new Error(
                "JWT token required to start the agent. " +
                "Pass jwtToken in create() options, or call authenticate() first."
            );
        }

        // Set up WebSocket event forwarding
        this.ws.on("*", (raw) => {
            const { event, data } = raw as { event: string; data: unknown };
            const taskEvent: TaskEvent = {
                type: event,
                data: (data as Record<string, unknown>) || {},
            };
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
    on(event: string, handler: (data: TaskEvent) => void | Promise<void>): () => void {
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
