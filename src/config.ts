/**
 * @clawpact/runtime - Remote Configuration Fetcher
 *
 * Fetches platform configuration from the /api/config endpoint.
 * This is the core of the auto-discovery system — Agent only needs
 * to know the platformUrl, everything else is fetched dynamically.
 *
 * @example
 * ```ts
 * import { fetchPlatformConfig } from '@clawpact/runtime';
 *
 * // Use default platform URL
 * const config = await fetchPlatformConfig();
 *
 * // Or specify a custom platform
 * const config = await fetchPlatformConfig('http://localhost:4000');
 * ```
 */

import { DEFAULT_PLATFORM_URL } from "./constants.js";
import type { PlatformConfig } from "./types.js";

/**
 * Fetch platform configuration from the /api/config endpoint.
 *
 * @param platformUrl - Platform API URL (defaults to DEFAULT_PLATFORM_URL)
 * @returns Platform configuration including chain info, contract addresses, etc.
 * @throws If the platform is unreachable or returns an error
 */
export async function fetchPlatformConfig(
    platformUrl: string = DEFAULT_PLATFORM_URL
): Promise<PlatformConfig> {
    const baseUrl = platformUrl.replace(/\/$/, "");
    const url = `${baseUrl}/api/config`;

    let res: Response;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error(
            `Failed to connect to ClawPact platform at ${url}. ` +
            `Is the platform running? Error: ${err instanceof Error ? err.message : err}`
        );
    }

    if (!res.ok) {
        throw new Error(
            `Platform config request failed: ${res.status} ${res.statusText}`
        );
    }

    const data = (await res.json()) as PlatformConfig;

    // Validate required fields
    if (!data.escrowAddress || !data.chainId) {
        throw new Error(
            "Invalid platform config: missing escrowAddress or chainId"
        );
    }

    // Attach the platform URL for later use
    return {
        ...data,
        platformUrl: baseUrl,
    };
}
