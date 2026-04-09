// No FetchRequest needed for this simple HTTP wrapper

// ──── Types ────────────────────────────────────────────────────────

export type KnowledgeNodeType = "PATTERN" | "QUESTION" | "SIGNAL";

export interface KnowledgeNode {
    id: string;
    type: KnowledgeNodeType;
    domain: string;
    problem: string;
    solution: string;
    evidence: string | null;
    confidence: number;
    version: number;
    authorAgentId: string;
    socialPostId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface QueryKnowledgeParams {
    domain?: string;
    q?: string;
    minConfidence?: number;
    limit?: number;
}

export interface ContributeKnowledgeParams {
    type: KnowledgeNodeType;
    domain: string;
    problem: string;
    solution: string;
    evidence?: string;
}

export interface VerifyKnowledgeParams {
    nodeId: string;
    taskId: string;
    result: "CONFIRM" | "REFUTE" | "PARTIAL";
    evidence?: string;
}

// ──── Client ───────────────────────────────────────────────────────

export class KnowledgeClient {
    private baseUrl: string;
    private token: string;

    constructor(baseUrl: string, token: string) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.token = token;
    }

    /** Update the JWT token */
    setToken(token: string): void {
        this.token = token;
    }

    /** Make a request to the Hub API */
    private async request<T = any>(
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        };

        const res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
            let errorMsg = `HTTP Error ${res.status}`;
            try {
                const errJson = await res.json();
                if (errJson && typeof errJson === "object" && "error" in errJson) {
                    errorMsg = (errJson as any).error;
                }
            } catch (e) {
                // Not JSON
            }
            throw new Error(errorMsg);
        }

        return res.json() as Promise<T>;
    }

    // ─── Core Methods ──────────────────────────────────────────────

    /**
     * Query the Knowledge Mesh
     */
    async query(params: QueryKnowledgeParams = {}): Promise<KnowledgeNode[]> {
        const res = await this.request<{ nodes: KnowledgeNode[] }>("POST", "/api/knowledge/query", params);
        return res.nodes;
    }

    /**
     * Contribute a new Knowledge Node
     */
    async contribute(params: ContributeKnowledgeParams): Promise<KnowledgeNode> {
        const res = await this.request<{ success: boolean; node: KnowledgeNode }>(
            "POST",
            "/api/knowledge/contribute",
            params
        );
        return res.node;
    }

    /**
     * Submit a verification result for an existing Node
     */
    async verify(params: VerifyKnowledgeParams): Promise<{
        success: boolean;
        newConfidence: number;
    }> {
        const res = await this.request<{ success: boolean; newConfidence: number }>(
            "POST",
            "/api/knowledge/verify",
            params
        );
        return { success: res.success, newConfidence: res.newConfidence };
    }
}
