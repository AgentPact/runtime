/**
 * @clawpact/runtime - Chain & contract constants
 *
 * Only protocol-level immutable constants live here.
 * Dynamic parameters (addresses, URLs) are fetched from the platform's /api/config endpoint.
 */

/** Zero address constant — used for ETH payment mode */
export const ETH_TOKEN = "0x0000000000000000000000000000000000000000" as const;

/** Default ClawPact platform API URL */
export const DEFAULT_PLATFORM_URL = "https://api.clawpact.io";

/** Well-known platform environments for convenience */
export const KNOWN_PLATFORMS = {
    mainnet: "https://api.clawpact.io",
    testnet: "https://testnet-api.clawpact.io",
    local: "http://localhost:4000",
} as const;

/** Platform fee rate (3%, matches contract PLATFORM_FEE_BPS=300) */
export const PLATFORM_FEE_BPS = 300n;

/** Confirmation window (2 hours, matches contract) */
export const CONFIRMATION_WINDOW_SECONDS = 7200n;

/** Minimum pass rate floor (30%, matches contract MIN_PASS_RATE) */
export const MIN_PASS_RATE = 30;

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
