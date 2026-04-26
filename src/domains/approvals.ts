import type {
  AgentCreateOptions,
  AgentConfig,
  TaskEvent,
  AssignmentSignatureData,
  ProviderRegistrationData,
  ProviderProfileData,
  ProviderProfileUpdate,
  AgentNodeStatus,
  AgentNodeAutomationMode,
  WorkerHostKind,
  WorkerRunStatus,
  ApprovalRequestKind,
  ApprovalRequestStatus,
  AgentNodeRegistrationData,
  AgentNodeUpdate,
  NodeAction,
  WorkerRunAction,
  TaskAction,
  NodeActionInput,
  AgentNodeData,
  WorkerRunCreateInput,
  WorkerRunUpdateInput,
  WorkerRunHeartbeatInput,
  ResolveStaleWorkerRunsInput,
  ResolveStaleWorkerRunsResult,
  WorkerRunData,
  WorkerTaskSessionStartInput,
  WorkerTaskSessionStartResult,
  WorkerTaskSessionResumeInput,
  WorkerTaskSessionResumeResult,
  WorkerRunClaimTaskInput,
  WorkerRunClaimTaskResult,
  WorkerTaskExecutionBrief,
  WorkerTaskExecutionBriefOptions,
  WorkerTaskSessionFinishInput,
  WorkerRunSubmitDeliveryInput,
  WorkerRunSubmitDeliveryResult,
  WorkerRunAbandonTaskInput,
  WorkerRunAbandonTaskResult,
  WorkerRunClaimAcceptanceTimeoutInput,
  WorkerRunClaimAcceptanceTimeoutResult,
  WorkerApprovalGateInput,
  WorkerApprovalGateResult,
  ApprovalRequestCreateInput,
  ApprovalRequestResolution,
  WaitForApprovalResolutionInput,
  WaitForApprovalResolutionResult,
  ResumeWorkerRunAfterApprovalInput,
  ResumeWorkerRunAfterApprovalResult,
  WaitForRequesterReviewOutcomeInput,
  WaitForRequesterReviewOutcomeResult,
  SyncWorkerRunWithRequesterReviewInput,
  SyncWorkerRunWithRequesterReviewResult,
  ExpireOverdueApprovalsInput,
  ExpireOverdueApprovalsResult,
  WaitForNodeEventInput,
  WaitForNodeEventResult,
  isActiveWorkerRunStatus,
  ApprovalRequestData,
  CurrentUserData,
  GetMyTasksOptions,
  AgentNotification,
  NodeActionLogEntry,
  NodeOpsIssue,
  NodeOpsOverviewData,
  NodeTaskFeedTask,
  NodeTaskFeedData,
  WorkerRunActionResult,
  TaskActionResult,
  AgentEventType
} from "../agent-types.js";
import type { AgentPactAgent } from "../agent.js";
import * as Types from "../agent-types.js";

export async function getApprovalRequests(agent: AgentPactAgent, options: {
        status?: ApprovalRequestStatus;
        taskId?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<ApprovalRequestData[]> {
        const params = new URLSearchParams();
        if (options.status) params.set("status", options.status);
        if (options.taskId) params.set("taskId", options.taskId);
        params.set("limit", String(options.limit ?? 20));
        params.set("offset", String(options.offset ?? 0));

        const res = await fetch(`${agent.platformUrl}/api/nodes/me/approvals?${params.toString()}`, {
            headers: agent.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch approval requests: ${res.status}`);
        }

        const body = (await res.json()) as { approvals?: ApprovalRequestData[] };
        return body.approvals ?? [];
    }

export async function requestApproval(agent: AgentPactAgent, input: ApprovalRequestCreateInput): Promise<ApprovalRequestData> {
        const res = await fetch(`${agent.platformUrl}/api/nodes/me/approvals`, {
            method: "POST",
            headers: agent.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to create approval request: ${res.status}`);
        }

        const body = (await res.json()) as { approval?: ApprovalRequestData };
        if (!body.approval) {
            throw new Error("Approval request payload missing");
        }

        return body.approval;
    }

export async function resolveApprovalRequest(agent: AgentPactAgent, approvalId: string, resolution: ApprovalRequestResolution): Promise<ApprovalRequestData> {
        const res = await fetch(`${agent.platformUrl}/api/nodes/me/approvals/${approvalId}/resolve`, {
            method: "POST",
            headers: agent.headers(),
            body: JSON.stringify(resolution),
        });

        if (!res.ok) {
            throw new Error(`Failed to resolve approval request: ${res.status}`);
        }

        const body = (await res.json()) as { approval?: ApprovalRequestData };
        if (!body.approval) {
            throw new Error("Resolved approval payload missing");
        }

        return body.approval;
    }

export async function waitForApprovalResolution(agent: AgentPactAgent, input: WaitForApprovalResolutionInput): Promise<WaitForApprovalResolutionResult> {
        const waitResult = await agent.waitForNodeEvent({
            events: ["NODE_APPROVAL_RESOLVED", "NODE_APPROVAL_EXPIRED"],
            taskId: input.taskId,
            approvalId: input.approvalId,
            timeoutMs: input.timeoutMs,
            autoWatchTask: input.autoWatchTask,
        });

        if (waitResult.timedOut) {
            return {
                timedOut: true,
                matchedEvent: waitResult.matchedEvent,
                event: waitResult.data,
            };
        }

        const approvals = await agent.getApprovalRequests({
            taskId: input.taskId,
            limit: 100,
            offset: 0,
        });
        const approval = approvals.find((item) => item.id === input.approvalId);
        if (!approval) {
            throw new Error(`Approval ${input.approvalId} was resolved but could not be reloaded`);
        }

        return {
            approval,
            timedOut: false,
            matchedEvent: waitResult.matchedEvent,
            event: waitResult.data,
        };
    }

export async function expireOverdueApprovals(agent: AgentPactAgent, input: ExpireOverdueApprovalsInput = {}): Promise<ExpireOverdueApprovalsResult> {
        const res = await fetch(`${agent.platformUrl}/api/nodes/me/approvals/expire-overdue`, {
            method: "POST",
            headers: agent.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to expire overdue approvals: ${res.status}`);
        }

        const body = (await res.json()) as {
            expiredCount?: number;
            approvals?: ApprovalRequestData[];
        };

        return {
            expiredCount: body.expiredCount ?? 0,
            approvals: body.approvals ?? [],
        };
    }

