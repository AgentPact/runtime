import type {
  ProviderRegistrationData,
  ProviderProfileData,
  ProviderProfileUpdate,
  AgentNodeRegistrationData,
  AgentNodeUpdate,
  NodeActionInput,
  AgentNodeData,
  CurrentUserData,
  NodeActionLogEntry,
  NodeOpsOverviewData,
  NodeTaskFeedData,
} from "../agent-types.js";
import type { AgentPactAgent } from "../agent.js";
import { getAgentInternals } from "../agent-internals.js";
function internals(agent: AgentPactAgent) {
  return getAgentInternals(agent);
}

export async function getNodeActionLog(
  agent: AgentPactAgent,
  options: {
    taskId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  entries: NodeActionLogEntry[];
  pagination: { total: number; limit: number; offset: number };
}> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 30));
  params.set("offset", String(options.offset ?? 0));
  if (options.taskId) params.set("taskId", options.taskId);

  const res = await fetch(
    `${internals(agent).platformUrl}/api/nodes/me/action-log?${params.toString()}`,
    { headers: internals(agent).headers() },
  );

  if (!res.ok)
    throw new Error(`Failed to fetch node action log: ${res.status}`);
  const body = (await res.json()) as {
    entries?: NodeActionLogEntry[];
    pagination?: { total: number; limit: number; offset: number };
  };

  return {
    entries: body.entries ?? [],
    pagination: body.pagination ?? {
      total: body.entries?.length ?? 0,
      limit: options.limit ?? 30,
      offset: options.offset ?? 0,
    },
  };
}

export async function registerProvider(
  agent: AgentPactAgent,
  agentType: string = "openclaw-agent",
  capabilities: string[] = ["general"],
): Promise<ProviderRegistrationData> {
  const res = await fetch(`${internals(agent).platformUrl}/api/providers`, {
    method: "POST",
    headers: internals(agent).headers(),
    body: JSON.stringify({ agentType, capabilities }),
  });

  if (!res.ok) throw new Error(`Failed to register provider: ${res.status}`);
  const body = (await res.json()) as {
    profile?: ProviderRegistrationData;
    data?: ProviderRegistrationData;
  };
  return (body.profile ?? body.data)!;
}

export async function ensureProviderProfile(
  agent: AgentPactAgent,
  agentType: string = "openclaw-agent",
  capabilities: string[] = ["general"],
): Promise<ProviderRegistrationData | null> {
  const meRes = await fetch(`${internals(agent).platformUrl}/api/auth/me`, {
    headers: internals(agent).headers(),
  });
  if (!meRes.ok) {
    throw new Error(`Failed to fetch current profile: ${meRes.status}`);
  }

  const meBody = (await meRes.json()) as {
    user?: { providerProfile?: ProviderRegistrationData | null };
  };
  if (meBody.user?.providerProfile) {
    return meBody.user.providerProfile;
  }

  return agent.registerProvider(agentType, capabilities);
}

export async function getCurrentUser(
  agent: AgentPactAgent,
): Promise<CurrentUserData> {
  const res = await fetch(`${internals(agent).platformUrl}/api/auth/me`, {
    headers: internals(agent).headers(),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch current user: ${res.status}`);
  }

  const body = (await res.json()) as { user?: CurrentUserData };
  if (!body.user) {
    throw new Error("Current user payload missing");
  }

  return body.user;
}

export async function getProviderProfile(
  agent: AgentPactAgent,
): Promise<ProviderProfileData> {
  const res = await fetch(`${internals(agent).platformUrl}/api/providers/me`, {
    headers: internals(agent).headers(),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch provider profile: ${res.status}`);
  }

  const body = (await res.json()) as { profile?: ProviderProfileData };
  if (!body.profile) {
    throw new Error("Provider profile payload missing");
  }

  return body.profile;
}

export async function updateProviderProfile(
  agent: AgentPactAgent,
  updates: ProviderProfileUpdate,
): Promise<ProviderProfileData> {
  const res = await fetch(`${internals(agent).platformUrl}/api/providers/me`, {
    method: "PATCH",
    headers: internals(agent).headers(),
    body: JSON.stringify(updates),
  });

  if (!res.ok) {
    throw new Error(`Failed to update provider profile: ${res.status}`);
  }

  const body = (await res.json()) as { profile?: ProviderProfileData };
  if (!body.profile) {
    throw new Error("Updated provider profile payload missing");
  }

  return body.profile;
}

export async function registerNode(
  agent: AgentPactAgent,
  input: AgentNodeRegistrationData,
): Promise<AgentNodeData> {
  const res = await fetch(`${internals(agent).platformUrl}/api/nodes`, {
    method: "POST",
    headers: internals(agent).headers(),
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    throw new Error(`Failed to register node: ${res.status}`);
  }

  const body = (await res.json()) as { node?: AgentNodeData };
  if (!body.node) {
    throw new Error("Agent Node payload missing");
  }

  return body.node;
}

export async function ensureNode(
  agent: AgentPactAgent,
  input?: Partial<AgentNodeRegistrationData>,
): Promise<AgentNodeData> {
  const me = await agent.getCurrentUser();
  if (me.agentNode) {
    return me.agentNode;
  }

  const fallbackName = `Node ${agent.walletAddress.slice(0, 6)}`;
  return agent.registerNode({
    displayName: input?.displayName ?? fallbackName,
    slug: input?.slug,
    description: input?.description,
    automationMode: input?.automationMode,
    headline: input?.headline,
    capabilityTags: input?.capabilityTags,
    policy: input?.policy,
    agentType: input?.agentType,
    capabilities: input?.capabilities,
    preferredCategories: input?.preferredCategories,
    portfolioLinks: input?.portfolioLinks,
  });
}

export async function getMyNode(agent: AgentPactAgent): Promise<AgentNodeData> {
  const res = await fetch(`${internals(agent).platformUrl}/api/nodes/me`, {
    headers: internals(agent).headers(),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Agent Node: ${res.status}`);
  }

  const body = (await res.json()) as { node?: AgentNodeData };
  if (!body.node) {
    throw new Error("Agent Node payload missing");
  }

  return body.node;
}

export async function updateMyNode(
  agent: AgentPactAgent,
  updates: AgentNodeUpdate,
): Promise<AgentNodeData> {
  const res = await fetch(`${internals(agent).platformUrl}/api/nodes/me`, {
    method: "PATCH",
    headers: internals(agent).headers(),
    body: JSON.stringify(updates),
  });

  if (!res.ok) {
    throw new Error(`Failed to update Agent Node: ${res.status}`);
  }

  const body = (await res.json()) as { node?: AgentNodeData };
  if (!body.node) {
    throw new Error("Updated Agent Node payload missing");
  }

  return body.node;
}

export async function executeNodeAction(
  agent: AgentPactAgent,
  input: NodeActionInput,
): Promise<AgentNodeData> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/nodes/me/actions`,
    {
      method: "POST",
      headers: internals(agent).headers(),
      body: JSON.stringify(input),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to execute node action: ${res.status}`);
  }

  const body = (await res.json()) as { node?: AgentNodeData };
  if (!body.node) {
    throw new Error("Node action payload missing");
  }

  return body.node;
}

export async function getNodeOpsOverview(
  agent: AgentPactAgent,
): Promise<NodeOpsOverviewData> {
  const res = await fetch(
    `${internals(agent).platformUrl}/api/nodes/me/ops-overview`,
    {
      headers: internals(agent).headers(),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch node ops overview: ${res.status}`);
  }

  const body = (await res.json()) as { overview?: NodeOpsOverviewData };
  if (!body.overview) {
    throw new Error("Node ops overview payload missing");
  }

  return body.overview;
}

export async function getNodeTaskFeed(
  agent: AgentPactAgent,
  options: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<NodeTaskFeedData> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 20));
  params.set("offset", String(options.offset ?? 0));
  if (options.status) params.set("status", options.status);

  const res = await fetch(
    `${internals(agent).platformUrl}/api/nodes/me/task-feed?${params.toString()}`,
    {
      headers: internals(agent).headers(),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch node task feed: ${res.status}`);
  }

  const body = (await res.json()) as { feed?: NodeTaskFeedData };
  if (!body.feed) {
    throw new Error("Node task feed payload missing");
  }

  return body.feed;
}
