import type { AgentPactAgent } from "../agent.js";
import type {
  AgentWalletOverview,
  TokenBalanceInfo,
  TransactionReceiptSummary,
  TransactionStatusSummary,
  GasQuoteRequest,
  GasQuoteSummary,
  PreflightCheckRequest,
  PreflightCheckResult,
} from "../types.js";
import { formatEther, formatUnits } from "viem";

export async function getNativeBalance(agent: AgentPactAgent): Promise<bigint> {
  return agent.client.getNativeBalance(agent.walletAddress);
}

export async function getUsdcBalance(agent: AgentPactAgent): Promise<bigint> {
  return agent.client.getUsdcBalance(agent.walletAddress);
}

export async function getWalletOverview(
  agent: AgentPactAgent,
): Promise<AgentWalletOverview> {
  const usdcAddress = agent.platformConfig.usdcAddress;

  // All 4 RPC calls fire in parallel (single round-trip)
  const [nativeBalanceWei, usdcRaw, usdcDecimals, usdcSymbol] =
    await Promise.all([
      agent.getNativeBalance(),
      agent.getUsdcBalance(),
      agent.client.getTokenDecimals(usdcAddress),
      agent.client.getTokenSymbol(usdcAddress),
    ]);

  return {
    chainId: agent.platformConfig.chainId,
    walletAddress: agent.walletAddress,
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

export async function getTokenBalanceInfo(
  agent: AgentPactAgent,
  token: `0x${string}`,
): Promise<TokenBalanceInfo> {
  const [raw, decimals, symbol] = await Promise.all([
    agent.client.getTokenBalance(token, agent.walletAddress),
    agent.client.getTokenDecimals(token),
    agent.client.getTokenSymbol(token),
  ]);

  return {
    tokenAddress: token,
    symbol,
    decimals,
    raw,
    formatted: formatUnits(raw, decimals),
  };
}

export async function getTokenAllowance(
  agent: AgentPactAgent,
  token: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return agent.client.getTokenAllowance(token, agent.walletAddress, spender);
}

export async function approveToken(
  agent: AgentPactAgent,
  token: `0x${string}`,
  spender: `0x${string}`,
  amount?: bigint,
): Promise<string> {
  const txHash = await agent.client.approveToken(token, spender, amount);
  console.error(`[Agent] Token approval submitted on-chain: ${txHash}`);
  return txHash;
}

export async function waitForTransaction(
  agent: AgentPactAgent,
  hash: `0x${string}`,
  options?: {
    confirmations?: number;
    timeoutMs?: number;
  },
): Promise<TransactionReceiptSummary> {
  return agent.client.waitForTransaction(hash, options);
}

export async function getTransactionStatus(
  agent: AgentPactAgent,
  hash: `0x${string}`,
): Promise<TransactionStatusSummary> {
  return agent.client.getTransactionStatus(hash);
}

export async function getGasQuote(
  agent: AgentPactAgent,
  params: GasQuoteRequest,
): Promise<GasQuoteSummary> {
  return agent.client.getGasQuote(params);
}

export async function preflightCheck(
  agent: AgentPactAgent,
  params: PreflightCheckRequest = {},
): Promise<PreflightCheckResult> {
  const notes: string[] = [];
  const blockingReasons: string[] = [];

  // ── Round 1: chainId + wallet + gasQuote in parallel ──
  const gasQuotePromise = params.action
    ? agent.getGasQuote({
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
    agent.client.getChainId(),
    agent.getWalletOverview(),
    gasQuotePromise,
  ]);

  if (!params.action) {
    notes.push("No action-specific gas quote requested.");
  }

  const chainOk = chainId === agent.platformConfig.chainId;
  if (!chainOk) {
    blockingReasons.push(
      `Connected chainId ${chainId} does not match expected chainId ${agent.platformConfig.chainId}`,
    );
  }

  const minNativeBalanceWei =
    params.minNativeBalanceWei ?? gasQuote?.estimatedTotalCostWei;
  const gasBalanceOk =
    minNativeBalanceWei !== undefined
      ? wallet.nativeBalanceWei >= minNativeBalanceWei
      : undefined;
  if (gasBalanceOk === false) {
    blockingReasons.push(
      `Native ETH balance ${wallet.nativeBalanceEth} is below the required threshold`,
    );
  }

  // ── Round 2: token balance + allowance in parallel ──
  let token: TokenBalanceInfo | undefined;
  let tokenBalanceOk: boolean | undefined;
  let allowance: PreflightCheckResult["allowance"];

  if (params.tokenAddress) {
    const tokenPromise = agent.getTokenBalanceInfo(params.tokenAddress);
    const allowancePromise = params.spender
      ? agent.getTokenAllowance(params.tokenAddress, params.spender)
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
          `Token balance ${token.formatted} ${token.symbol} is below the required amount`,
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
        allowance.requiredFormatted = formatUnits(
          params.requiredAmount,
          token.decimals,
        );
        allowance.sufficient = allowanceRaw >= params.requiredAmount;
        if (!allowance.sufficient) {
          blockingReasons.push(
            `Allowance ${allowance.formatted} is below the required amount ${allowance.requiredFormatted}`,
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
    expectedChainId: agent.platformConfig.chainId,
    walletAddress: agent.walletAddress,
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
