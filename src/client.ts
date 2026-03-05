/**
 * @clawpact/runtime - ClawPact Escrow Client
 *
 * High-level SDK for interacting with the ClawPactEscrowV2 contract.
 * Wraps viem read/write operations with typed parameters.
 */
import {
    type PublicClient,
    type WalletClient,
    type Transport,
    type Chain,
    type Account,
    type Hash,
    erc20Abi,
    maxUint256,
} from "viem";
import { clawPactEscrowAbi } from "./abi.js";
import { ETH_TOKEN } from "./constants.js";
import type {
    EscrowRecord,
    CreateEscrowParams,
    RequestRevisionParams,
    ClaimTaskParams,
    ChainConfig,
} from "./types.js";
import { TaskState } from "./types.js";

export class ClawPactClient {
    private readonly publicClient: PublicClient;
    private readonly walletClient?: WalletClient<Transport, Chain, Account>;
    private readonly escrowAddress: `0x${string}`;

    constructor(
        publicClient: PublicClient,
        config: ChainConfig,
        walletClient?: WalletClient<Transport, Chain, Account>
    ) {
        this.publicClient = publicClient;
        this.walletClient = walletClient;
        this.escrowAddress = config.escrowAddress;
    }

    // ========================= Read Functions =========================

    /** Get escrow record by ID */
    async getEscrow(escrowId: bigint): Promise<EscrowRecord> {
        const result = await this.publicClient.readContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "getEscrow",
            args: [escrowId],
        });

        return result as unknown as EscrowRecord;
    }

    /** Get the next escrow ID */
    async getNextEscrowId(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "nextEscrowId",
        }) as Promise<bigint>;
    }

    /** Get assignment nonce for an escrow */
    async getAssignmentNonce(escrowId: bigint): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "assignmentNonces",
            args: [escrowId],
        }) as Promise<bigint>;
    }

    /** Get all fund weights for an escrow (on-chain stored) */
    async getFundWeights(escrowId: bigint): Promise<number[]> {
        return this.publicClient.readContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "getFundWeights",
            args: [escrowId],
        }) as Promise<number[]>;
    }

    /** Get fund weight for a specific criterion */
    async getFundWeight(escrowId: bigint, criteriaIndex: number): Promise<number> {
        return this.publicClient.readContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "getFundWeight",
            args: [escrowId, criteriaIndex],
        }) as Promise<number>;
    }

    /** Check if a token is allowed */
    async isTokenAllowed(token: `0x${string}`): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "allowedTokens",
            args: [token],
        }) as Promise<boolean>;
    }

    /** Get the platform signer address */
    async getPlatformSigner(): Promise<`0x${string}`> {
        return this.publicClient.readContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "platformSigner",
        }) as Promise<`0x${string}`>;
    }

    // ========================= Write Functions =========================

    private requireWallet(): WalletClient<Transport, Chain, Account> {
        if (!this.walletClient) {
            throw new Error("WalletClient required for write operations");
        }
        return this.walletClient;
    }

    /**
     * Create a new escrow.
     * For ETH: pass token=ETH_TOKEN, totalAmount=0n, and include value in options.
     * For ERC20: pass token address and totalAmount. Will auto-approve if needed.
     */
    async createEscrow(
        params: CreateEscrowParams,
        /** ETH value to send (only for ETH mode) */
        value?: bigint
    ): Promise<Hash> {
        const wallet = this.requireWallet();

        // Auto-approve ERC20 if needed
        if (params.token !== ETH_TOKEN && params.totalAmount > 0n) {
            await this.ensureAllowance(
                params.token,
                params.totalAmount
            );
        }

        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "createEscrow",
            args: [
                params.taskHash,
                params.deliveryDurationSeconds,
                params.maxRevisions,
                params.acceptanceWindowHours,
                params.criteriaCount,
                params.fundWeights,
                params.token,
                params.totalAmount,
            ],
            value: params.token === ETH_TOKEN ? value : 0n,
        });
    }

    /** Claim a task using platform's EIP-712 signature */
    async claimTask(params: ClaimTaskParams): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "claimTask",
            args: [
                params.escrowId,
                params.nonce,
                params.expiredAt,
                params.platformSignature,
            ],
        });
    }

    /** Confirm task after reviewing materials — sets deliveryDeadline on-chain */
    async confirmTask(escrowId: bigint): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "confirmTask",
            args: [escrowId],
        });
    }

    /** Decline task during confirmation window (tracked on-chain, 3x causes suspension) */
    async declineTask(escrowId: bigint): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "declineTask",
            args: [escrowId],
        });
    }

    /** Submit delivery artifacts */
    async submitDelivery(
        escrowId: bigint,
        deliveryHash: `0x${string}`
    ): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "submitDelivery",
            args: [escrowId, deliveryHash],
        });
    }

    /** Voluntarily abandon task during execution (lighter penalty than timeout) */
    async abandonTask(escrowId: bigint): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "abandonTask",
            args: [escrowId],
        });
    }

    /** Accept delivery and release funds */
    async acceptDelivery(escrowId: bigint): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "acceptDelivery",
            args: [escrowId],
        });
    }

    /** Request revision with per-criterion pass/fail — passRate computed on-chain */
    async requestRevision(params: RequestRevisionParams): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "requestRevision",
            args: [params.escrowId, params.reasonHash, params.criteriaResults],
        });
    }

    /** Cancel task (only from Created/ConfirmationPending) */
    async cancelTask(escrowId: bigint): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "cancelTask",
            args: [escrowId],
        });
    }

    /** Claim acceptance timeout */
    async claimAcceptanceTimeout(escrowId: bigint): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "claimAcceptanceTimeout",
            args: [escrowId],
        });
    }

    /** Claim delivery timeout */
    async claimDeliveryTimeout(escrowId: bigint): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "claimDeliveryTimeout",
            args: [escrowId],
        });
    }

    /** Claim confirmation timeout */
    async claimConfirmationTimeout(escrowId: bigint): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "claimConfirmationTimeout",
            args: [escrowId],
        });
    }

    // ========================= Utility =========================

    /** Calculate deposit rate based on maxRevisions */
    static getDepositRate(maxRevisions: number): number {
        if (maxRevisions <= 3) return 5;
        if (maxRevisions <= 5) return 8;
        if (maxRevisions <= 7) return 12;
        return 15;
    }

    /** Calculate reward and deposit from total amount */
    static splitAmount(totalAmount: bigint, maxRevisions: number) {
        const depositRate = BigInt(ClawPactClient.getDepositRate(maxRevisions));
        const rewardAmount = (totalAmount * 100n) / (100n + depositRate);
        const requesterDeposit = totalAmount - rewardAmount;
        return { rewardAmount, requesterDeposit };
    }

    /** Validate fund weights (3-10 criteria, 5-40% each, sum=100) */
    static validateFundWeights(weights: number[]): void {
        if (weights.length < 3 || weights.length > 10) {
            throw new Error(`Expected 3-10 criteria, got ${weights.length}`);
        }
        let total = 0;
        for (const w of weights) {
            if (w < 5 || w > 40) {
                throw new Error(`Each weight must be 5-40%, got ${w}%`);
            }
            total += w;
        }
        if (total !== 100) {
            throw new Error(`Weights must sum to 100%, got ${total}%`);
        }
    }

    /** Check if escrow is in a terminal state */
    static isTerminal(state: TaskState): boolean {
        return [
            TaskState.Accepted,
            TaskState.Settled,
            TaskState.TimedOut,
            TaskState.Cancelled,
        ].includes(state);
    }

    /** Ensure ERC20 allowance for the escrow contract */
    private async ensureAllowance(
        token: `0x${string}`,
        amount: bigint
    ): Promise<void> {
        const wallet = this.requireWallet();
        const currentAllowance = (await this.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [wallet.account.address, this.escrowAddress],
        })) as bigint;

        if (currentAllowance < amount) {
            const hash = await wallet.writeContract({
                address: token,
                abi: erc20Abi,
                functionName: "approve",
                args: [this.escrowAddress, maxUint256],
            });
            await this.publicClient.waitForTransactionReceipt({ hash });
        }
    }
}
