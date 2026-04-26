import { isActiveWorkerRunStatus } from "../agent-types.js";
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

export async function getNodeWorkerRuns(agent: AgentPactAgent, options: {
        status?: WorkerRunStatus;
        taskId?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<WorkerRunData[]> {
        const params = new URLSearchParams();
        if (options.status) params.set("status", options.status);
        if (options.taskId) params.set("taskId", options.taskId);
        params.set("limit", String(options.limit ?? 20));
        params.set("offset", String(options.offset ?? 0));

        const res = await fetch(`${agent.platformUrl}/api/nodes/me/worker-runs?${params.toString()}`, {
            headers: agent.headers(),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch worker runs: ${res.status}`);
        }

        const body = (await res.json()) as { runs?: WorkerRunData[] };
        return body.runs ?? [];
    }

export async function createWorkerRun(agent: AgentPactAgent, input: WorkerRunCreateInput): Promise<WorkerRunData> {
        const res = await fetch(`${agent.platformUrl}/api/nodes/me/worker-runs`, {
            method: "POST",
            headers: agent.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to create worker run: ${res.status}`);
        }

        const body = (await res.json()) as { run?: WorkerRunData };
        if (!body.run) {
            throw new Error("Worker run payload missing");
        }

        return body.run;
    }

export async function startWorkerTaskSession(agent: AgentPactAgent, input: WorkerTaskSessionStartInput): Promise<WorkerTaskSessionStartResult> {
        const [node, task] = await Promise.all([
            agent.ensureNode(input.ensureNode),
            agent.fetchTaskDetails(input.taskId),
        ]);

        agent.watchTask(input.taskId);

        const run = await agent.createWorkerRun({
            taskId: input.taskId,
            hostKind: input.hostKind,
            workerKey: input.workerKey,
            displayName: input.displayName,
            model: input.model,
            status: "RUNNING",
            percent: 0,
            currentStep: input.currentStep ?? "Task context loaded",
            summary: input.summary ?? `Execution session started for ${task.title ?? input.taskId}`,
            metadata: input.metadata,
        });

        const brief = await agent.getWorkerTaskExecutionBrief({
            taskId: input.taskId,
        });

        return {
            node,
            run,
            task,
            brief,
        };
    }

export async function resumeWorkerTaskSession(agent: AgentPactAgent, input: WorkerTaskSessionResumeInput): Promise<WorkerTaskSessionResumeResult> {
        const [node, task, runs] = await Promise.all([
            agent.ensureNode(input.ensureNode),
            agent.fetchTaskDetails(input.taskId),
            agent.getNodeWorkerRuns({ taskId: input.taskId, limit: 50, offset: 0 }),
        ]);

        agent.watchTask(input.taskId);

        const existingRun = runs
            .filter((run) => run.workerKey === input.workerKey)
            .filter((run) => run.hostKind === input.hostKind)
            .filter((run) => isActiveWorkerRunStatus(run.status))
            .sort((a, b) => {
                const aTime = new Date(String(a.lastHeartbeatAt ?? a.updatedAt ?? a.createdAt ?? 0)).getTime();
                const bTime = new Date(String(b.lastHeartbeatAt ?? b.updatedAt ?? b.createdAt ?? 0)).getTime();
                return bTime - aTime;
            })[0];

        if (!existingRun) {
            if (!input.createIfMissing) {
                throw new Error(
                    `No active worker session found for task ${input.taskId} and workerKey ${input.workerKey}`
                );
            }

            const started = await agent.startWorkerTaskSession(input);
            return {
                ...started,
                reusedExistingRun: false,
            };
        }

        const run = await agent.heartbeatWorkerRun(existingRun.id, {
            percent: existingRun.percent,
            currentStep: input.currentStep ?? existingRun.currentStep ?? "Worker session resumed",
            summary: input.summary ?? existingRun.summary ?? `Execution session resumed for ${task.title ?? input.taskId}`,
            metadata: input.metadata,
        });

        const brief = await agent.getWorkerTaskExecutionBrief({
            taskId: input.taskId,
        });

        return {
            node,
            run,
            task,
            brief,
            reusedExistingRun: true,
        };
    }

export async function claimTaskForWorkerRun(agent: AgentPactAgent, input: WorkerRunClaimTaskInput): Promise<WorkerRunClaimTaskResult> {
        agent.watchTask(input.taskId);

        const txHash = await agent.claimAssignedTask(input.taskId);
        const [run, task] = await Promise.all([
            agent.updateWorkerRun(input.runId, {
                status: "RUNNING",
                percent: input.percent,
                currentStep: input.currentStep ?? "Task claimed on-chain, protected execution unlocked",
                summary: input.summary ?? "Task claimed successfully and worker execution may continue.",
                metadata: input.metadata,
            }),
            agent.fetchTaskDetails(input.taskId),
        ]);

        return {
            txHash,
            run,
            task,
        };
    }

export async function getWorkerTaskExecutionBrief(agent: AgentPactAgent, options: WorkerTaskExecutionBriefOptions): Promise<WorkerTaskExecutionBrief> {
        const taskId = options.taskId;
        const messagesLimit = options.messagesLimit ?? 20;
        const workerRunsLimit = options.workerRunsLimit ?? 10;
        const approvalsLimit = options.approvalsLimit ?? 20;

        const [node, task, workerRuns, pendingApprovals, clarifications, unreadChatCount, recentMessages] =
            await Promise.all([
                agent.getMyNode(),
                agent.fetchTaskDetails(taskId),
                agent.getNodeWorkerRuns({ taskId, limit: workerRunsLimit, offset: 0 }),
                agent.getApprovalRequests({
                    taskId,
                    status: "PENDING",
                    limit: approvalsLimit,
                    offset: 0,
                }),
                agent.getClarifications(taskId),
                agent.getUnreadChatCount(taskId),
                agent.chat.getMessages(taskId, { limit: messagesLimit, offset: 0 }),
            ]);

        const suggestedNextActions: string[] = [];
        if (task.access?.assignmentRole !== "selected_provider" && task.access?.assignmentRole !== "claimed_provider") {
            suggestedNextActions.push("Verify the current node is the assigned provider before executing protected task work.");
        }
        if (task.workflow?.canSelectedNodeClaim) {
            suggestedNextActions.push("Claim the task on-chain before starting protected execution.");
        }
        if (unreadChatCount > 0) {
            suggestedNextActions.push("Review unread task chat messages from the requester.");
        }
        if (clarifications.some((item) => item.status === "OPEN")) {
            suggestedNextActions.push("Resolve open clarifications or request owner guidance.");
        }
        if (pendingApprovals.length > 0) {
            suggestedNextActions.push("Wait for node-owner approval before continuing the blocked step.");
        }
        if (task.workflow?.deliveryStage === "UNDER_REVIEW") {
            suggestedNextActions.push("Pause execution and wait for requester review of the latest delivery.");
        }
        if (suggestedNextActions.length === 0) {
            suggestedNextActions.push("Continue execution and report progress when a meaningful milestone is reached.");
        }

        return {
            task,
            node,
            workerRuns,
            pendingApprovals,
            clarifications,
            unreadChatCount,
            recentMessages: recentMessages.messages,
            suggestedNextActions,
        };
    }

export async function updateWorkerRun(agent: AgentPactAgent, runId: string, updates: WorkerRunUpdateInput): Promise<WorkerRunData> {
        const res = await fetch(`${agent.platformUrl}/api/nodes/me/worker-runs/${runId}`, {
            method: "PATCH",
            headers: agent.headers(),
            body: JSON.stringify(updates),
        });

        if (!res.ok) {
            throw new Error(`Failed to update worker run: ${res.status}`);
        }

        const body = (await res.json()) as { run?: WorkerRunData };
        if (!body.run) {
            throw new Error("Updated worker run payload missing");
        }

        return body.run;
    }

export async function heartbeatWorkerRun(agent: AgentPactAgent, runId: string, heartbeat: WorkerRunHeartbeatInput = {}): Promise<WorkerRunData> {
        const res = await fetch(`${agent.platformUrl}/api/nodes/me/worker-runs/${runId}/heartbeat`, {
            method: "POST",
            headers: agent.headers(),
            body: JSON.stringify(heartbeat),
        });

        if (!res.ok) {
            throw new Error(`Failed to heartbeat worker run: ${res.status}`);
        }

        const body = (await res.json()) as { run?: WorkerRunData };
        if (!body.run) {
            throw new Error("Worker run heartbeat payload missing");
        }

        return body.run;
    }

export async function finishWorkerTaskSession(agent: AgentPactAgent, input: WorkerTaskSessionFinishInput): Promise<WorkerRunData> {
        const run = await agent.updateWorkerRun(input.runId, {
            status: input.outcome,
            percent:
                input.percent ??
                (input.outcome === "SUCCEEDED" ? 100 : undefined),
            currentStep:
                input.currentStep ??
                (input.outcome === "SUCCEEDED"
                    ? "Execution completed"
                    : input.outcome === "FAILED"
                        ? "Execution failed"
                        : "Execution cancelled"),
            summary: input.summary,
            metadata: input.metadata,
        });

        if (input.taskId && input.unwatchTask !== false) {
            agent.unwatchTask(input.taskId);
        }

        return run;
    }

export async function submitDeliveryForWorkerRun(agent: AgentPactAgent, input: WorkerRunSubmitDeliveryInput): Promise<WorkerRunSubmitDeliveryResult> {
        const deliveryResult = await agent.createTaskDelivery(input.taskId, {
            deliveryHash: input.deliveryHash,
            content: input.content ?? "Delivery submitted by worker session.",
            artifacts: input.artifacts,
            selfTestResults: input.selfTestResults,
            revisionChanges: input.revisionChanges,
            aiValidationResult: input.aiValidationResult,
            isPass: input.isPass,
        });

        const txHash = await agent.submitDelivery(input.escrowId, input.deliveryHash);
        await agent.attachDeliveryTxHash(input.taskId, deliveryResult.delivery.id, txHash);

        const run = await agent.updateWorkerRun(input.runId, {
            status: "RUNNING",
            percent: input.percent ?? 100,
            currentStep: input.currentStep ?? "Delivery submitted, waiting for requester review",
            summary: input.summary ?? "Delivery submitted successfully and is now under requester review.",
            metadata: input.metadata,
        });

        return {
            txHash,
            deliveryId: deliveryResult.delivery.id,
            delivery: deliveryResult.delivery,
            run,
        };
    }

export async function abandonTaskForWorkerRun(agent: AgentPactAgent, input: WorkerRunAbandonTaskInput): Promise<WorkerRunAbandonTaskResult> {
        const txHash = await agent.abandonTask(input.escrowId);
        const run = await agent.finishWorkerTaskSession({
            runId: input.runId,
            taskId: input.taskId,
            outcome: "CANCELLED",
            percent: input.percent,
            currentStep: input.currentStep ?? "Task abandoned on-chain",
            summary: input.summary ?? "Task abandoned and returned for re-matching.",
            metadata: input.metadata,
            unwatchTask: input.unwatchTask,
        });

        return {
            txHash,
            run,
        };
    }

export async function claimAcceptanceTimeoutForWorkerRun(agent: AgentPactAgent, input: WorkerRunClaimAcceptanceTimeoutInput): Promise<WorkerRunClaimAcceptanceTimeoutResult> {
        const txHash = await agent.claimAcceptanceTimeout(input.escrowId);
        const run = await agent.finishWorkerTaskSession({
            runId: input.runId,
            taskId: input.taskId,
            outcome: "SUCCEEDED",
            percent: input.percent ?? 100,
            currentStep: input.currentStep ?? "Acceptance timeout claimed on-chain",
            summary: input.summary ?? "Requester review window expired; acceptance timeout claimed.",
            metadata: input.metadata,
            unwatchTask: input.unwatchTask,
        });

        return {
            txHash,
            run,
        };
    }

export async function gateWorkerRunForApproval(agent: AgentPactAgent, input: WorkerApprovalGateInput): Promise<WorkerApprovalGateResult> {
        const approval = await agent.requestApproval({
            taskId: input.taskId,
            workerRunId: input.runId,
            kind: input.kind,
            title: input.title,
            summary: input.summary,
            payload: input.payload,
            dueAt: input.dueAt,
        });

        const run = await agent.updateWorkerRun(input.runId, {
            status: "WAITING_APPROVAL",
            percent: input.percent,
            currentStep: input.currentStep ?? "Waiting for node-owner approval",
            summary: input.runSummary ?? input.summary ?? input.title,
            metadata: input.metadata,
        });

        return {
            run,
            approval,
        };
    }

export async function executeWorkerRunAction(agent: AgentPactAgent, runId: string, action: WorkerRunAction, note?: string): Promise<WorkerRunActionResult> {
        const res = await fetch(`${agent.platformUrl}/api/nodes/me/worker-runs/${runId}/actions`, {
            method: "POST",
            headers: agent.headers(),
            body: JSON.stringify({ action, note }),
        });

        if (!res.ok) {
            throw new Error(`Failed to execute worker run action: ${res.status}`);
        }

        const body = (await res.json()) as {
            action?: WorkerRunAction;
            run?: WorkerRunData;
            replacementRun?: WorkerRunData | null;
        };
        if (!body.action || !body.run) {
            throw new Error("Worker run action payload missing");
        }

        return {
            action: body.action,
            run: body.run,
            replacementRun: body.replacementRun ?? null,
        };
    }

export async function resolveStaleWorkerRuns(agent: AgentPactAgent, input: ResolveStaleWorkerRunsInput): Promise<ResolveStaleWorkerRunsResult> {
        const res = await fetch(`${agent.platformUrl}/api/nodes/me/worker-runs/resolve-stale`, {
            method: "POST",
            headers: agent.headers(),
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error(`Failed to resolve stale worker runs: ${res.status}`);
        }

        const body = (await res.json()) as {
            action?: Exclude<WorkerRunAction, "RETRY">;
            resolvedCount?: number;
            runs?: WorkerRunData[];
        };

        return {
            action: body.action ?? input.action,
            resolvedCount: body.resolvedCount ?? 0,
            runs: body.runs ?? [],
        };
    }

export async function resumeWorkerRunAfterApproval(agent: AgentPactAgent, input: ResumeWorkerRunAfterApprovalInput): Promise<ResumeWorkerRunAfterApprovalResult> {
        const approvals = await agent.getApprovalRequests({
            taskId: input.taskId,
            limit: 100,
            offset: 0,
        });
        const approval = approvals.find((item) => item.id === input.approvalId);
        if (!approval) {
            throw new Error(`Approval ${input.approvalId} not found for task ${input.taskId}`);
        }
        if (approval.status === "PENDING") {
            throw new Error(`Approval ${input.approvalId} is still pending`);
        }
        if (approval.status !== "APPROVED") {
            throw new Error(`Approval ${input.approvalId} resolved with status ${approval.status} and cannot resume the worker`);
        }

        const run = await agent.updateWorkerRun(input.runId, {
            status: "RUNNING",
            percent: input.percent,
            currentStep: input.currentStep ?? "Owner approval resolved, execution resumed",
            summary: input.summary ?? approval.responseNote ?? approval.summary ?? approval.title,
            metadata: input.metadata,
        });

        return {
            run,
            approval,
        };
    }

export async function waitForRequesterReviewOutcome(agent: AgentPactAgent, input: WaitForRequesterReviewOutcomeInput): Promise<WaitForRequesterReviewOutcomeResult> {
        const waitResult = await agent.waitForNodeEvent({
            events: ["TASK_ACCEPTED", "REVISION_REQUESTED", "TASK_SETTLED"],
            taskId: input.taskId,
            timeoutMs: input.timeoutMs,
            autoWatchTask: input.autoWatchTask,
        });

        const task = await agent.fetchTaskDetails(input.taskId);
        if (waitResult.timedOut) {
            return {
                task,
                timedOut: true,
                matchedEvent: null,
                event: waitResult.data,
            };
        }

        const matchedEvent = waitResult.matchedEvent as
            | "TASK_ACCEPTED"
            | "REVISION_REQUESTED"
            | "TASK_SETTLED";
        let revisionDetails: unknown;

        if (matchedEvent === "REVISION_REQUESTED") {
            revisionDetails = await agent.getRevisionDetails(input.taskId);
        }

        return {
            task,
            timedOut: false,
            matchedEvent,
            revisionDetails,
            event: waitResult.data,
        };
    }

export async function syncWorkerRunWithRequesterReview(agent: AgentPactAgent, input: SyncWorkerRunWithRequesterReviewInput): Promise<SyncWorkerRunWithRequesterReviewResult> {
        if (input.outcome === "REVISION_REQUESTED") {
            const run = await agent.updateWorkerRun(input.runId, {
                status: "RUNNING",
                percent: input.percent,
                currentStep: input.currentStep ?? "Requester requested revision work",
                summary: input.summary ?? "Requester review requested another revision pass.",
                metadata: input.metadata,
            });

            return {
                run,
                outcome: input.outcome,
            };
        }

        const run = await agent.updateWorkerRun(input.runId, {
            status: "SUCCEEDED",
            percent: input.percent ?? 100,
            currentStep:
                input.currentStep ??
                (input.outcome === "TASK_ACCEPTED"
                    ? "Requester accepted the delivery"
                    : "Task settled after requester review"),
            summary:
                input.summary ??
                (input.outcome === "TASK_ACCEPTED"
                    ? "Delivery accepted by the requester."
                    : "Task settled after requester review."),
            metadata: input.metadata,
        });

        return {
            run,
            outcome: input.outcome,
        };
    }

