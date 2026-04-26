import type {
  TaskTimelineItem,
  TaskDetailsData,
  TaskListItem,
} from "../types.js";
import type {
  AssignmentSignatureData,
  TaskAction,
  GetMyTasksOptions,
  TaskActionResult,
} from "../agent-types.js";
import type { AgentPactAgent } from "../agent.js";
import { getAgentInternals } from "../agent-internals.js";
import { queryAvailableTasksFromEnvio } from "../transport/envio.js";
import { computeDeliveryHash } from "../delivery/upload.js";
function internals(agent: AgentPactAgent) {
  return getAgentInternals(agent);
}

export async function confirmTask(
  agent: AgentPactAgent,
  escrowId: bigint,
): Promise<string> {
  return agent.client.confirmTask(escrowId);
}

export async function declineTask(
  agent: AgentPactAgent,
  escrowId: bigint,
): Promise<string> {
  return agent.client.declineTask(escrowId);
}

export function getAssignmentSignature(
  agent: AgentPactAgent,
  taskId: string,
): AssignmentSignatureData | undefined {
  return internals(agent).assignmentSignatures.get(taskId);
}

export async function claimAssignedTask(
  agent: AgentPactAgent,
  taskId: string,
): Promise<string> {
  let assignment = internals(agent).assignmentSignatures.get(taskId);

  if (!assignment) {
    const res = await fetch(
      `${internals(agent).platformUrl}/api/escrow/assignment/${taskId}`,
      {
        method: "GET",
        headers: internals(agent).headers(),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Failed to recover assignment signature: ${res.status} ${errText}`,
      );
    }

    const body = (await res.json()) as {
      data?: {
        taskId: string;
        escrowId: string;
        nonce: string;
        expiredAt: string;
        signature: string;
      };
    };

    if (!body.data) {
      throw new Error(
        "Assignment signature payload missing from platform response",
      );
    }

    assignment = {
      taskId: body.data.taskId,
      escrowId: BigInt(body.data.escrowId),
      nonce: BigInt(body.data.nonce),
      expiredAt: BigInt(body.data.expiredAt),
      signature: body.data.signature as `0x${string}`,
    };
    internals(agent).assignmentSignatures.set(taskId, assignment);
  }

  const txHash = await agent.client.claimTask({
    escrowId: assignment.escrowId,
    nonce: assignment.nonce,
    expiredAt: assignment.expiredAt,
    platformSignature: assignment.signature,
  });

  internals(agent).assignmentSignatures.delete(taskId);
  console.error(`[Agent] Task claimed on-chain: ${txHash} for task ${taskId}`);
  return txHash;
}

export async function createTaskDelivery(
  agent: AgentPactAgent,
  taskId: string,
  payload: {
    deliveryHash: string;
    content: string;
    artifacts?: unknown;
    selfTestResults?: unknown;
    revisionChanges?: unknown;
    aiValidationResult?: string;
    isPass?: boolean;
  },
): Promise<{ success: boolean; delivery: any; transactionData: any }> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/tasks/${taskId}/deliveries`,
    {
      method: "POST",
      headers: internals(agent).headers(),
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Failed to create task delivery: ${res.status} ${errText}`);
  }
  return res.json() as Promise<{
    success: boolean;
    delivery: any;
    transactionData: any;
  }>;
}

export async function attachDeliveryTxHash(
  agent: AgentPactAgent,
  taskId: string,
  deliveryId: string,
  txHash: string,
): Promise<unknown> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/tasks/${taskId}/deliveries/${deliveryId}/submit`,
    {
      method: "POST",
      headers: internals(agent).headers(),
      body: JSON.stringify({ txHash }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Failed to attach delivery tx hash: ${res.status} ${errText}`,
    );
  }
  return res.json();
}

export async function submitDelivery(
  agent: AgentPactAgent,
  escrowId: bigint,
  deliveryHash: string,
): Promise<string> {
  const formattedHash = deliveryHash.startsWith("0x")
    ? (deliveryHash as `0x${string}`)
    : (`0x${deliveryHash}` as `0x${string}`);
  const txHash = await agent.client.submitDelivery(escrowId, formattedHash);
  console.error(
    `[Agent] Delivery submitted on-chain: ${txHash} for escrow: ${escrowId}`,
  );
  return txHash;
}

export async function abandonTask(
  agent: AgentPactAgent,
  escrowId: bigint,
): Promise<string> {
  const txHash = await agent.client.abandonTask(escrowId);
  console.error(`[Agent] Task abandoned on-chain: ${txHash}`);
  return txHash;
}

export async function reportProgress(
  agent: AgentPactAgent,
  taskId: string,
  percent: number,
  description: string,
): Promise<void> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/tasks/${taskId}/progress`,
    {
      method: "POST",
      headers: internals(agent).headers(),
      body: JSON.stringify({
        percent: Math.max(0, Math.min(100, percent)),
        description,
      }),
    },
  );
  if (!res.ok) throw new Error(`Failed to report progress: ${res.status}`);
  console.error(`[Agent] Progress reported: ${percent}% — ${description}`);
}

export async function claimAcceptanceTimeout(
  agent: AgentPactAgent,
  escrowId: bigint,
): Promise<string> {
  const txHash = await agent.client.claimAcceptanceTimeout(escrowId);
  console.error(`[Agent] Acceptance timeout claimed: ${txHash}`);
  return txHash;
}

export async function claimDeliveryTimeout(
  agent: AgentPactAgent,
  escrowId: bigint,
): Promise<string> {
  const txHash = await agent.client.claimDeliveryTimeout(escrowId);
  console.error(`[Agent] Delivery timeout claimed: ${txHash}`);
  return txHash;
}

export async function claimConfirmationTimeout(
  agent: AgentPactAgent,
  escrowId: bigint,
): Promise<string> {
  return agent.client.claimConfirmationTimeout(escrowId);
}

export async function getRevisionDetails(
  agent: AgentPactAgent,
  taskId: string,
  revision?: number,
): Promise<unknown> {
  const params = revision ? `?revision=${revision}` : "";
  const res = await fetch(
    `${internals(agent).platformUrl}/api/revisions/${taskId}${params}`,
    { headers: internals(agent).headers() },
  );
  if (!res.ok)
    throw new Error(`Failed to fetch revision details: ${res.status}`);
  const body = (await res.json()) as { data?: unknown; revisions?: unknown[] };
  return body.data ?? body.revisions ?? body;
}

export async function getTaskTimeline(
  agent: AgentPactAgent,
  taskId: string,
): Promise<TaskTimelineItem[]> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/tasks/${taskId}/timeline`,
    { headers: internals(agent).headers() },
  );

  if (!res.ok) throw new Error(`Failed to fetch task timeline: ${res.status}`);
  const body = (await res.json()) as { data?: TaskTimelineItem[] };
  return body.data ?? [];
}

export async function fetchTaskDetails(
  agent: AgentPactAgent,
  taskId: string,
): Promise<TaskDetailsData> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/tasks/${taskId}/details`,
    { headers: internals(agent).headers() },
  );

  if (!res.ok) throw new Error(`Failed to fetch task details: ${res.status}`);
  const body = (await res.json()) as { data?: TaskDetailsData };
  return (body.data ?? body) as TaskDetailsData;
}

export async function executeTaskAction(
  agent: AgentPactAgent,
  taskId: string,
  action: TaskAction,
  note?: string,
): Promise<TaskActionResult> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/nodes/me/tasks/${taskId}/actions`,
    {
      method: "POST",
      headers: internals(agent).headers(),
      body: JSON.stringify({ action, note }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to execute task action: ${res.status}`);
  }

  const body = (await res.json()) as {
    action?: TaskAction;
    note?: string;
    task?: TaskActionResult["task"];
  };
  if (!body.action || !body.task) {
    throw new Error("Task action payload missing");
  }

  return {
    action: body.action,
    note: body.note,
    task: body.task,
  };
}

export async function getAvailableTasks(
  agent: AgentPactAgent,
  options: {
    limit?: number;
    offset?: number;
    status?: string;
  } = {},
): Promise<TaskListItem[]> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 20));
  params.set("offset", String(options.offset ?? 0));
  if (options.status) params.set("status", options.status);

  const fetchFromPlatform = async () => {
    const res = await fetch(
      `${internals(agent).platformUrl}/api/tasks?${params}`,
      { headers: internals(agent).headers() },
    );

    if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
    const body = (await res.json()) as {
      data?: TaskListItem[];
      tasks?: TaskListItem[];
    };
    return body.data || body.tasks || [];
  };

  try {
    return await fetchFromPlatform();
  } catch (platformError) {
    if (!agent.platformConfig.envioUrl) {
      throw platformError;
    }

    return queryAvailableTasksFromEnvio(agent.platformConfig, options);
  }
}

export async function getMyTasks(
  agent: AgentPactAgent,
  options: GetMyTasksOptions = {},
): Promise<TaskListItem[]> {
  const currentUser = await agent.getCurrentUser();
  const params = new URLSearchParams();
  params.set("providerId", currentUser.id);
  params.set("limit", String(options.limit ?? 20));
  params.set("offset", String(options.offset ?? 0));
  if (options.status) params.set("status", options.status);
  if (options.assignment) params.set("assignment", options.assignment);
  if (options.sortBy) params.set("sortBy", options.sortBy);

  const res = await fetch(
    `${internals(agent).platformUrl}/api/tasks?${params.toString()}`,
    {
      headers: internals(agent).headers(),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch provider tasks: ${res.status}`);
  }

  const body = (await res.json()) as {
    data?: TaskListItem[];
    tasks?: TaskListItem[];
  };
  return body.data ?? body.tasks ?? [];
}

export async function bidOnTask(
  agent: AgentPactAgent,
  taskId: string,
  message?: string,
): Promise<unknown> {
  const res = await fetch(`${internals(agent).platformUrl}/api/matching/bid`, {
    method: "POST",
    headers: internals(agent).headers(),
    body: JSON.stringify({ taskId, message }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Failed to bid: ${res.status}${detail ? ` ${detail}` : ""}`,
    );
  }
  const body = (await res.json()) as { data?: unknown; task?: unknown };
  return body.data ?? body.task ?? body;
}

export async function rejectInvitation(
  agent: AgentPactAgent,
  taskId: string,
  reason?: string,
): Promise<void> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/matching/reject-invitation`,
    {
      method: "POST",
      headers: internals(agent).headers(),
      body: JSON.stringify({ taskId, reason }),
    },
  );

  if (!res.ok) throw new Error(`Failed to reject invitation: ${res.status}`);
}
