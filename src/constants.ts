/**
 * @clawpact/runtime - Chain & contract constants
 *
 * SECURITY: Critical contract addresses are hardcoded here to prevent
 * man-in-the-middle attacks. Never trust contract addresses from API responses.
 *
 * Only protocol-level immutable constants live here.
 * Dynamic parameters (rpcUrl) can be overridden by the user.
 */

/** Zero address constant — used for ETH payment mode */
export const ETH_TOKEN = "0x0000000000000000000000000000000000000000" as const;

// ─── Network Configuration ───────────────────────────────────────

/** Base Sepolia (testnet) chain ID */
export const CHAIN_ID_BASE_SEPOLIA = 84532 as const;

/** Base Mainnet chain ID */
export const CHAIN_ID_BASE_MAINNET = 8453 as const;

/** Active chain ID — change this when migrating to mainnet */
export const CHAIN_ID = CHAIN_ID_BASE_SEPOLIA;

/** Default RPC URL for the active chain */
export const DEFAULT_RPC_URL = "https://sepolia.base.org" as const;

/** Default Base Mainnet RPC URL (for future mainnet migration) */
export const DEFAULT_BASE_MAINNET_RPC_URL = "https://mainnet.base.org" as const;

/** Block explorer URL */
export const EXPLORER_URL = "https://sepolia.basescan.org" as const;

// ─── Contract Addresses (UUPS Proxy — immutable) ─────────────────

/**
 * ClawPactEscrow proxy address (Base Sepolia).
 * SECURITY: This is a UUPS proxy — the address never changes, only the
 * implementation behind it can be upgraded by the contract owner.
 */
export const ESCROW_ADDRESS = "0xB8C77709fF82D7F90CA1695a7495d0A33D2d19a5" as `0x${string}`;

/**
 * USDC token address on Base Sepolia.
 * This is the official Circle-deployed USDC on the testnet.
 */
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;

/**
 * TipJar proxy address (Base Sepolia).
 * Used for the Agent Tavern tipping feature.
 * TODO: Update with deployed address after TipJar contract deployment.
 */
export const TIPJAR_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// ─── Platform Configuration ──────────────────────────────────────

/** Default ClawPact platform API URL */
export const DEFAULT_PLATFORM_URL = "https://api.clawpact.io";

/** Default WebSocket URL (derived from platform URL) */
export const DEFAULT_WS_URL = "wss://api.clawpact.io/ws";

/** Well-known platform environments for convenience */
export const KNOWN_PLATFORMS = {
    mainnet: "https://api.clawpact.io",
    testnet: "https://testnet-api.clawpact.io",
    local: "http://localhost:4000",
} as const;

// ─── Protocol Constants ──────────────────────────────────────────

/** Platform fee rate (3%, matches contract PLATFORM_FEE_BPS=300) */
export const PLATFORM_FEE_BPS = 300n;

/** Confirmation window (2 hours, matches contract) */
export const CONFIRMATION_WINDOW_SECONDS = 7200n;

/** Minimum pass rate floor (30%, matches contract MIN_PASS_RATE) */
export const MIN_PASS_RATE = 30;

/** Maximum decline count before task is suspended (matches contract) */
export const MAX_DECLINE_COUNT = 3;

/** EIP-712 domain for signing */
export const EIP712_DOMAIN = {
    name: "ClawPact",
    version: "2",
} as const;

/** EIP-712 TaskAssignment type definition */
export const TASK_ASSIGNMENT_TYPES = {
    TaskAssignment: [
        { name: "escrowId", type: "uint256" },
        { name: "agent", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "expiredAt", type: "uint256" },
    ],
} as const;
