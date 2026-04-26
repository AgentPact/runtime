/**
 * @agentpactai/runtime - EIP-712 Signing Utilities
 *
 * Used by the platform backend to sign task assignment authorizations.
 * These signatures are verified on-chain by AgentPactEscrow.claimTask().
 */
import {
    type Account,
    type WalletClient,
    type Transport,
    type Chain,
} from "viem";
import type { TaskAssignmentData, ChainConfig } from "./types.js";
import { EIP712_DOMAIN, TASK_ASSIGNMENT_TYPES } from "./constants.js";

/**
 * Sign an EIP-712 TaskAssignment for agent claim authorization.
 *
 * @param walletClient - viem WalletClient with the platform signer account
 * @param config - Chain configuration (used for verifyingContract)
 * @param data - Assignment data: escrowId, agent address, nonce, expiredAt
 * @returns The EIP-712 signature as hex string
 *
 * @example
 * ```ts
 * import { signTaskAssignment, BASE_SEPOLIA } from '@agentpactai/runtime';
 *
 * const signature = await signTaskAssignment(walletClient, BASE_SEPOLIA, {
 *   escrowId: 1n,
 *   agent: '0x...',
 *   nonce: 0n,
 *   expiredAt: BigInt(Math.floor(Date.now() / 1000) + 1800),
 * });
 * ```
 */
export async function signTaskAssignment(
    walletClient: WalletClient<Transport, Chain, Account>,
    config: ChainConfig,
    data: TaskAssignmentData
): Promise<`0x${string}`> {
    const signature = await walletClient.signTypedData({
        domain: {
            ...EIP712_DOMAIN,
            chainId: config.chainId,
            verifyingContract: config.escrowAddress,
        },
        types: TASK_ASSIGNMENT_TYPES,
        primaryType: "TaskAssignment",
        message: {
            escrowId: data.escrowId,
            agent: data.agent,
            nonce: data.nonce,
            expiredAt: data.expiredAt,
        },
    });

    return signature;
}

/**
 * Generate an assignment with auto-calculated expiry.
 *
 * @param walletClient - Platform signer wallet
 * @param config - Chain config
 * @param escrowId - The escrow to assign
 * @param agent - Agent address being authorized
 * @param nonce - Current nonce from contract
 * @param expiryMinutes - How many minutes the signature is valid (default: 30)
 */
export async function createSignedAssignment(
    walletClient: WalletClient<Transport, Chain, Account>,
    config: ChainConfig,
    escrowId: bigint,
    agent: `0x${string}`,
    nonce: bigint,
    expiryMinutes: number = 30
) {
    const expiredAt = BigInt(Math.floor(Date.now() / 1000) + expiryMinutes * 60);

    const signature = await signTaskAssignment(walletClient, config, {
        escrowId,
        agent,
        nonce,
        expiredAt,
    });

    return { escrowId, agent, nonce, expiredAt, signature };
}

// ─── ExternalSigner — Private Key Isolation ──────────────────────────────────

/**
 * A signing adapter that does NOT expose raw private keys to the runtime.
 * All signing operations are delegated to an external implementation.
 *
 * ## Usage (IPC / isolated process)
 * ```ts
 * import type { ExternalSigner } from "@agentpactai/runtime";
 *
 * const signer: ExternalSigner = {
 *   address: "0xABCDEF...",
 *   signMessage: async (msg) => ipcBridge.signMessage(msg),
 *   signTypedData: async (data) => ipcBridge.signTypedData(data),
 *   signTransaction: async (tx) => ipcBridge.signTransaction(tx),
 * };
 * const agent = await AgentPactAgent.create({ signer, platformUrl: "..." });
 * ```
 */
export interface ExternalSigner {
    /** The wallet address associated with this signer */
    readonly address: `0x${string}`;

    /** Sign an arbitrary message (EIP-191 personal_sign) */
    signMessage(message: string): Promise<`0x${string}`>;

    /**
     * Sign EIP-712 typed data.
     * The implementation receives the full domain + types + value object.
     */
    signTypedData(data: {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        primaryType: string;
        message: Record<string, unknown>;
    }): Promise<`0x${string}`>;

    /**
     * Sign and broadcast a transaction.
     * Returns the transaction hash.
     */
    signTransaction(tx: {
        to: `0x${string}`;
        data?: `0x${string}`;
        value?: bigint;
        gas?: bigint;
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
        nonce?: number;
        chainId?: number;
    }): Promise<`0x${string}`>;
}

/**
 * Create an ExternalSigner from a viem WalletClient.
 * This is the "local / direct" mode bridge — for backward compatibility.
 */
export function createLocalSigner(
    walletClient: WalletClient<Transport, Chain, Account>,
): ExternalSigner {
    return {
        address: walletClient.account.address,

        signMessage: (message) =>
            walletClient.signMessage({ message }),

        signTypedData: (data) =>
            walletClient.signTypedData({
                domain: data.domain as Record<string, unknown>,
                types: data.types as Record<string, Array<{ name: string; type: string }>>,
                primaryType: data.primaryType as string,
                message: data.message as Record<string, unknown>,
            }),

        signTransaction: (tx) =>
            walletClient.sendTransaction(tx as Parameters<typeof walletClient.sendTransaction>[0]),
    };
}
