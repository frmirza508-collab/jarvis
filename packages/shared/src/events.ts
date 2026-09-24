import type { PermissionCategory, RiskLevel } from './permissions.js';

/** Typed agent-communication contract. Agents never exchange free-form text conventions. */
export const AGENT_EVENT_TYPES = [
  'TASK_REQUEST',
  'TASK_ACCEPTED',
  'TASK_PROGRESS',
  'TASK_RESULT',
  'TASK_FAILED',
  'NEED_INFORMATION',
  'NEED_PERMISSION',
  'REVIEW_REQUEST',
  'REVIEW_RESULT',
  'BLOCKED',
  'COMPLETED',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface Artifact {
  kind: 'file' | 'url' | 'text' | 'json';
  label: string;
  /** Path, URL, or inline content depending on kind. */
  value: string;
}

export interface Evidence {
  source: string;
  excerpt?: string;
  verified: boolean;
}

export interface TaskSpec {
  taskId: string;
  parentTaskId?: string;
  goal: string;
  input?: Record<string, unknown>;
  /** Capability the task requires; used for routing. */
  capability?: string;
  requestedBy: string;
  deadlineMs?: number;
}

export interface TaskOutput {
  summary: string;
  data?: unknown;
  artifacts: Artifact[];
  evidence: Evidence[];
}

interface Base<T extends AgentEventType, P> {
  id: string;
  type: T;
  ts: string;
  from: string;
  to?: string;
  taskId: string;
  correlationId?: string;
  payload: P;
}

export type AgentEvent =
  | Base<'TASK_REQUEST', TaskSpec>
  | Base<'TASK_ACCEPTED', { agentId: string }>
  | Base<'TASK_PROGRESS', { message: string; percent?: number }>
  | Base<'TASK_RESULT', TaskOutput>
  | Base<'TASK_FAILED', { error: string; code: string; retryable: boolean }>
  | Base<'NEED_INFORMATION', { question: string; fields?: string[] }>
  | Base<
      'NEED_PERMISSION',
      { requestId: string; categories: PermissionCategory[]; risk: RiskLevel; description: string }
    >
  | Base<'REVIEW_REQUEST', { output: TaskOutput; criteria: string[] }>
  | Base<'REVIEW_RESULT', { approved: boolean; issues: string[]; corrected?: TaskOutput }>
  | Base<'BLOCKED', { reason: string }>
  | Base<'COMPLETED', TaskOutput>;

export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
