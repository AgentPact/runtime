import type { AgentPactAgent } from "./agent.js";
import type { AssignmentSignatureData, TaskEvent } from "./agent-types.js";

export interface AgentInternals {
  readonly platformUrl: string;
  readonly assignmentSignatures: Map<string, AssignmentSignatureData>;
  headers(): Record<string, string>;
  dispatch(event: string, data: TaskEvent): void;
}

const agentInternals = new WeakMap<AgentPactAgent, AgentInternals>();

export function setAgentInternals(
  agent: AgentPactAgent,
  internals: AgentInternals,
): void {
  agentInternals.set(agent, internals);
}

export function getAgentInternals(agent: AgentPactAgent): AgentInternals {
  const internals = agentInternals.get(agent);
  if (!internals) {
    throw new Error("Agent internals are not initialized");
  }
  return internals;
}
