/**
 * @agentpactai/runtime - AgentPact Escrow Client
 *
 * High-level SDK for interacting with the AgentPactEscrow contract.
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
    formatEther,
    maxUint256,
} from "viem";
import { ESCROW_ABI as clawPactEscrowAbi, TIPJAR_ABI as clawPactTipJarAbi } from "./abi.js";
import { ETH_TOKEN } from "./constants.js";
import type {
    EscrowRecord,
    CreateEscrowParams,
    RequestRevisionParams,
    ClaimTaskParams,
    ChainConfig,
    GasQuoteRequest,
    GasQuoteSummary,
    TransactionStatusSummary,
} from "./types.js";
import { TaskState } from "./types.js";

export class AgentPactClient {
    private readonly publicClient: PublicClient;
    private readonly walletClient?: WalletClient<Transport, Chain, Account>;
    private readonly escrowAddress: `0x${string}`;
    private readonly tipJarAddress: `0x${string}`;
    private readonly usdcAddress: `0x${string}`;
    private readonly explorerUrl: string;

    constructor(
        publicClient: PublicClient,
        config: ChainConfig,
        walletClient?: WalletClient<Transport, Chain, Account>
    ) {
        this.publicClient = publicClient;
        this.walletClient = walletClient;
        this.escrowAddress = config.escrowAddress;
        this.tipJarAddress = config.tipJarAddress;
        this.usdcAddress = config.usdcAddress;
        this.explorerUrl = config.explorerUrl.replace(/\/$/, "");
    }

    // ========================= Read Functions =========================

    /** Get escrow record by ID */
    async getEscrow(escrowId: bigint): Promise<EscrowRecord> {
        const result = (await this.publicClient.readContract({
            address: this.escrowAddress,
            abi: clawPactEscrowAbi,
            functionName: "getEscrow",
            args: [escrowId],
        })) as unknown as EscrowRecord;

        try {
            // Only fetch fund weights if there are criteria
            if (result.criteriaCount > 0) {
                const weights = await this.getFundWeights(escrowId);
                result.fundWeights = weights;
            }
        } catch (error) {
            console.warn(`Failed to fetch fund weights for escrow ${escrowId}:`, error);
        }

        return result;
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

    /** Get the active RPC chain ID */
    async getChainId(): Promise<number> {
        return this.publicClient.getChainId();
    }

    /** Get native ETH balance for an address */
    async getNativeBalance(address: `0x${string}`): Promise<bigint> {
        return this.publicClient.getBalance({ address });
    }

    /** Get ERC20 token balance for an address */
    async getTokenBalance(
        token: `0x${string}`,
        address: `0x${string}`
    ): Promise<bigint> {
        return this.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
        }) as Promise<bigint>;
    }

    /** Get ERC20 decimals metadata */
    async getTokenDecimals(token: `0x${string}`): Promise<number> {
        return this.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "decimals",
        }) as Promise<number>;
    }

    /** Get ERC20 symbol metadata */
    async getTokenSymbol(token: `0x${string}`): Promise<string> {
        return this.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "symbol",
        }) as Promise<string>;
    }

    /** Get configured USDC balance for an address */
    async getUsdcBalance(address: `0x${string}`): Promise<bigint> {
        return this.getTokenBalance(this.usdcAddress, address);
    }

    /** Get ERC20 token allowance for owner -> spender */
    async getTokenAllowance(
        token: `0x${string}`,
        owner: `0x${string}`,
        spender: `0x${string}`
    ): Promise<bigint> {
        return this.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, spender],
        }) as Promise<bigint>;
    }

    /** Estimate gas and fee cost for a supported write action */
    async getGasQuote(params: GasQuoteRequest): Promise<GasQuoteSummary> {
        const wallet = this.requireWallet();
        const chainId = await this.getChainId();
        const fees = await this.getFeeQuote();
        const effectiveFeePerGas = fees.maxFeePerGasWei ?? fees.gasPriceWei ?? 0n;

        let target: `0x${string}`;
        let gasEstimate: bigint;

        switch (params.action) {
            case "approve_token": {
                if (!params.tokenAddress || !params.spender) {
                    throw new Error("approve_token requires tokenAddress and spender");
                }
                target = params.tokenAddress;
                gasEstimate = await this.publicClient.estimateContractGas({
                    account: wallet.account,
                    address: params.tokenAddress,
                    abi: erc20Abi,
                    functionName: "approve",
                    args: [params.spender, params.amount ?? maxUint256],
                });
                break;
            }
            case "confirm_task": {
                if (params.escrowId === undefined) {
                    throw new Error("confirm_task requires escrowId");
                }
                target = this.escrowAddress;
                gasEstimate = await this.publicClient.estimateContractGas({
                    account: wallet.account,
                    address: this.escrowAddress,
                    abi: clawPactEscrowAbi,
                    functionName: "confirmTask",
                    args: [params.escrowId],
                });
                break;
            }
            case "decline_task": {
                if (params.escrowId === undefined) {
                    throw new Error("decline_task requires escrowId");
                }
                target = this.escrowAddress;
                gasEstimate = await this.publicClient.estimateContractGas({
                    account: wallet.account,
                    address: this.escrowAddress,
                    abi: clawPactEscrowAbi,
                    functionName: "declineTask",
                    args: [params.escrowId],
                });
                break;
            }
            case "submit_delivery": {
                if (params.escrowId === undefined || !params.deliveryHash) {
                    throw new Error("submit_delivery requires escrowId and deliveryHash");
                }
                target = this.escrowAddress;
                gasEstimate = await this.publicClient.estimateContractGas({
                    account: wallet.account,
                    address: this.escrowAddress,
                    abi: clawPactEscrowAbi,
                    functionName: "submitDelivery",
                    args: [params.escrowId, params.deliveryHash],
                });
                break;
            }
            case "abandon_task": {
                if (params.escrowId === undefined) {
                    throw new Error("abandon_task requires escrowId");
                }
                target = this.escrowAddress;
                gasEstimate = await this.publicClient.estimateContractGas({
                    account: wallet.account,
                    address: this.escrowAddress,
                    abi: clawPactEscrowAbi,
                    functionName: "abandonTask",
                    args: [params.escrowId],
                });
                break;
            }
            case "claim_acceptance_timeout": {
                if (params.escrowId === undefined) {
                    throw new Error("claim_acceptance_timeout requires escrowId");
                }
                target = this.escrowAddress;
                gasEstimate = await this.publicClient.estimateContractGas({
                    account: wallet.account,
                    address: this.escrowAddress,
                    abi: clawPactEscrowAbi,
                    functionName: "claimAcceptanceTimeout",
                    args: [params.escrowId],
                });
                break;
            }
            case "claim_delivery_timeout": {
                if (params.escrowId === undefined) {
                    throw new Error("claim_delivery_timeout requires escrowId");
                }
                target = this.escrowAddress;
                gasEstimate = await this.publicClient.estimateContractGas({
                    account: wallet.account,
                    address: this.escrowAddress,
                    abi: clawPactEscrowAbi,
                    functionName: "claimDeliveryTimeout",
                    args: [params.escrowId],
                });
                break;
            }
            case "claim_confirmation_timeout": {
                if (params.escrowId === undefined) {
                    throw new Error("claim_confirmation_timeout requires escrowId");
                }
                target = this.escrowAddress;
                gasEstimate = await this.publicClient.estimateContractGas({
                    account: wallet.account,
                    address: this.escrowAddress,
                    abi: clawPactEscrowAbi,
                    functionName: "claimConfirmationTimeout",
                    args: [params.escrowId],
                });
                break;
            }
            default: {
                throw new Error(`Unsupported gas quote action: ${String(params.action)}`);
            }
        }

        const gasLimitSuggested = (gasEstimate * 12n) / 10n;
        const estimatedTotalCostWei = gasLimitSuggested * effectiveFeePerGas;

        return {
            action: params.action,
            chainId,
            walletAddress: wallet.account.address,
            target,
            feeModel: fees.maxFeePerGasWei ? "eip1559" : "legacy",
            gasEstimate,
            gasLimitSuggested,
            gasPriceWei: fees.gasPriceWei,
            maxFeePerGasWei: fees.maxFeePerGasWei,
            maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei,
            estimatedTotalCostWei,
            estimatedTotalCostEth: formatEther(estimatedTotalCostWei),
        };
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
                params.totalAmount,
                this.escrowAddress
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

    /** Confirm task after reviewing materials �?sets deliveryDeadline on-chain */
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

    /** Request revision with per-criterion pass/fail �?passRate computed on-chain */
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

    /** Send a tip using the signed payload from the platform */
    async sendTip(
        tipper: `0x${string}`,
        recipient: `0x${string}`,
        amount: bigint,
        postId: string,
        nonce: bigint,
        expiredAt: bigint,
        signature: `0x${string}`,
        usdcAddress: `0x${string}`
    ): Promise<Hash> {
        const wallet = this.requireWallet();

        // Ensure TipJar is allowed to transfer USDC on behalf of the tipper
        if (amount > 0n) {
            await this.ensureAllowance(usdcAddress, amount, this.tipJarAddress);
        }

        return wallet.writeContract({
            address: this.tipJarAddress,
            abi: clawPactTipJarAbi,
            functionName: "tip",
            args: [
                recipient,
                amount,
                postId,
                nonce,
                expiredAt,
                signature
            ],
        });
    }

    /** Approve an ERC20 spender */
    async approveToken(
        token: `0x${string}`,
        spender: `0x${string}`,
        amount: bigint = maxUint256
    ): Promise<Hash> {
        const wallet = this.requireWallet();
        return wallet.writeContract({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, amount],
        });
    }

    /** Wait for a transaction receipt */
    async waitForTransaction(
        hash: `0x${string}`,
        options: {
            confirmations?: number;
            timeoutMs?: number;
        } = {}
    ): Promise<{
        transactionHash: `0x${string}`;
        status: "success" | "reverted";
        blockNumber: bigint;
        gasUsed: bigint;
        effectiveGasPrice?: bigint;
        explorerUrl?: string;
    }> {
        const receipt = await this.publicClient.waitForTransactionReceipt({
            hash,
            confirmations: options.confirmations ?? 1,
            timeout: options.timeoutMs,
        });

        return {
            transactionHash: receipt.transactionHash,
            status: receipt.status === "success" ? "success" : "reverted",
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
            explorerUrl: this.getExplorerTxUrl(receipt.transactionHash),
        };
    }

    /** Get the current status of a transaction without waiting */
    async getTransactionStatus(hash: `0x${string}`): Promise<TransactionStatusSummary> {
        try {
            const receipt = await this.publicClient.getTransactionReceipt({ hash });
            const latestBlock = await this.publicClient.getBlockNumber();
            const confirmations = latestBlock >= receipt.blockNumber
                ? Number(latestBlock - receipt.blockNumber + 1n)
                : 0;

            return {
                transactionHash: receipt.transactionHash,
                status: receipt.status === "success" ? "success" : "reverted",
                found: true,
                confirmations,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed,
                effectiveGasPrice: receipt.effectiveGasPrice,
                explorerUrl: this.getExplorerTxUrl(receipt.transactionHash),
            };
        } catch {
            try {
                const tx = await this.publicClient.getTransaction({ hash });
                return {
                    transactionHash: tx.hash,
                    status: "pending",
                    found: true,
                    confirmations: 0,
                    explorerUrl: this.getExplorerTxUrl(tx.hash),
                };
            } catch {
                return {
                    transactionHash: hash,
                    status: "not_found",
                    found: false,
                    confirmations: 0,
                    explorerUrl: this.getExplorerTxUrl(hash),
                };
            }
        }
    }

    /** Build a block explorer transaction URL */
    getExplorerTxUrl(hash: `0x${string}`): string {
        return `${this.explorerUrl}/tx/${hash}`;
    }

    private async getFeeQuote(): Promise<{
        gasPriceWei?: bigint;
        maxFeePerGasWei?: bigint;
        maxPriorityFeePerGasWei?: bigint;
    }> {
        try {
            const fees = await this.publicClient.estimateFeesPerGas();
            return {
                gasPriceWei: fees.gasPrice,
                maxFeePerGasWei: fees.maxFeePerGas,
                maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas,
            };
        } catch {
            return {
                gasPriceWei: await this.publicClient.getGasPrice(),
            };
        }
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
        const depositRate = BigInt(AgentPactClient.getDepositRate(maxRevisions));
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

    /** Ensure ERC20 allowance for the target contract */
    private async ensureAllowance(
        token: `0x${string}`,
        amount: bigint,
        target: `0x${string}`
    ): Promise<void> {
        const wallet = this.requireWallet();
        const currentAllowance = await this.getTokenAllowance(
            token,
            wallet.account.address,
            target
        );

        if (currentAllowance < amount) {
            const hash = await this.approveToken(token, target, maxUint256);
            await this.publicClient.waitForTransactionReceipt({ hash });
        }
    }
}
