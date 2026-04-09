import { keccak256, stringToHex, toHex } from "viem";

/**
 * @agentpactai/runtime - Delivery Upload Utilities
 *
 * Provides file hashing and optional upload helpers for task deliveries.
 * Computes keccak256 hashes for on-chain delivery submission.
 *
 * @example
 * ```ts
 * import { computeDeliveryHash, uploadDelivery } from '@agentpactai/runtime';
 *
 * const hash = await computeDeliveryHash(fileBuffer);
 * // Native file uploads are optional and may be disabled by Platform.
 * const result = await uploadDelivery(
 *   'http://localhost:4000',
 *   jwtToken,
 *   taskId,
 *   fileBuffer,
 *   'report.pdf'
 * );
 * ```
 */

/**
 * Compute keccak256 hash of delivery content.
 * Returns a bytes32 hex string suitable for on-chain submission.
 *
 * @param data - File content as Uint8Array
 * @returns `0x${string}` keccak256 hash
 */
export async function computeDeliveryHash(
    data: Uint8Array
): Promise<`0x${string}`> {
    return keccak256(toHex(data));
}

/**
 * Compute keccak256 hash from a string.
 */
export async function computeStringHash(
    content: string
): Promise<`0x${string}`> {
    return keccak256(stringToHex(content));
}

/** Upload result from the Hub API */
export interface UploadResult {
    fileId: string;
    url: string;
    hash: `0x${string}`;
    size: number;
    filename: string;
}

/**
 * Upload a delivery artifact to Hub.
 * Uses the optional `/api/storage/upload` presigned URL flow.
 * Prefer off-chain delivery text plus external links unless Platform explicitly
 * enables native file uploads.
 *
 * @param baseUrl - Hub API base URL
 * @param token - JWT authentication token
 * @param taskId - Task ID this delivery belongs to
 * @param data - File content as Uint8Array
 * @param filename - Original filename
 * @param visibility - File visibility ('public' | 'confidential')
 * @returns Upload result with file URL and hash
 */
export async function uploadDelivery(
    baseUrl: string,
    token: string,
    taskId: string,
    data: Uint8Array,
    filename: string,
    visibility: "public" | "confidential" = "confidential"
): Promise<UploadResult> {
    const url = `${baseUrl.replace(/\/$/, "")}/api/storage/upload`;

    // Step 1: Get presigned upload URL
    const presignRes = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            taskId,
            filename,
            contentType: guessContentType(filename),
            visibility,
        }),
    });

    if (!presignRes.ok) {
        if (presignRes.status === 410) {
            throw new Error(
                "Native file uploads are disabled by Platform. Use off-chain delivery text and external links instead."
            );
        }
        throw new Error(`Failed to get upload URL: ${presignRes.status}`);
    }

    const presignBody = (await presignRes.json()) as { data: { uploadUrl: string; fileId: string } };
    const { uploadUrl, fileId } = presignBody.data;

    // Step 2: Upload file to presigned URL
    const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
            "Content-Type": guessContentType(filename),
        },
        body: data,
    });

    if (!uploadRes.ok) {
        throw new Error(`Failed to upload file: ${uploadRes.status}`);
    }

    // Step 3: Compute hash
    const hash = await computeDeliveryHash(data);

    return {
        fileId,
        url: uploadUrl.split("?")[0], // Remove query params for clean URL
        hash,
        size: data.length,
        filename,
    };
}

/**
 * Guess MIME content type from filename extension.
 */
function guessContentType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const types: Record<string, string> = {
        pdf: "application/pdf",
        zip: "application/zip",
        tar: "application/x-tar",
        gz: "application/gzip",
        json: "application/json",
        md: "text/markdown",
        txt: "text/plain",
        html: "text/html",
        css: "text/css",
        js: "application/javascript",
        ts: "application/typescript",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        svg: "image/svg+xml",
        mp4: "video/mp4",
    };
    return types[ext || ""] || "application/octet-stream";
}
