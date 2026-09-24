// Wire types mirrored from the local core API (services/orchestrator).
export type CapabilityState =
  'active' | 'degraded' | 'not_configured' | 'disabled' | 'planned' | 'unsupported';
export interface Capability {
  id: string;
  label: string;
  state: CapabilityState;
  reason?: string;
  requirement?: string;
}
export interface LicenseStatus {
  mode: 'licensed' | 'development';
  hasKey?: boolean;
  decision?: string;
  premium: boolean;
  plan?: string | null;
  status?: string;
  entitlementUntil?: string | null;
  lastOnlineCheck?: string;
  error?: string;
}
export interface CoreStatus {
  version: string;
  platform: string;
  capabilities: Capability[];
  providers: Array<{ id: string; configured: boolean }>;
  license: LicenseStatus | null;
  agents: { total: number; byDepartment: Record<string, number> };
  activeRequests: string[];
  memory: Record<string, number>;
}
export interface Metrics {
  tasksStarted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  toolErrors: number;
  reviewCorrections: number;
  totalLatencyMs: number;
  lastActiveAt?: string;
}
export interface AgentInfo {
  id: string;
  name: string;
  department: string;
  description: string;
  capabilities: string[];
  tools: string[];
  skills: string[];
  permissions: string[];
  modelRole: string;
  dynamic: boolean;
  health: {
    state: 'registered' | 'idle' | 'busy' | 'degraded' | 'disabled';
    consecutiveFailures: number;
    lastError?: string;
    unavailableTools: string[];
  };
  metrics: Metrics;
  activeTasks: number;
}
export interface PermissionRequest {
  id: string;
  actor: string;
  action: string;
  categories: string[];
  risk: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  target?: string;
}
export interface AgentEvent {
  id: string;
  type: string;
  ts: string;
  from: string;
  to?: string;
  taskId: string;
  correlationId?: string;
  payload: Record<string, unknown>;
}
export interface NodeState {
  id: string;
  label: string;
  assignee?: string;
  dependsOn: string[];
  status: string;
  attempts: number;
  error?: string;
}
export interface TaskOutput {
  summary: string;
  artifacts: Array<{ kind: string; label: string; value: string }>;
  evidence: Array<{ source: string; excerpt?: string; verified: boolean }>;
}
export interface RequestResult {
  requestId: string;
  status: string;
  language: string;
  reply: string;
  plan?: { mode: string; tasks: Array<{ id: string; agent: string; goal: string; dependsOn: string[] }> };
  outputs: Record<string, TaskOutput>;
  verification: { ok: boolean; problems: string[] };
  agents: string[];
}
export interface MemoryItem {
  id: string;
  scope: string;
  scopeId: string;
  kind: string;
  content: string;
  tags: string[];
  source: string;
  verified: boolean;
  createdAt: string;
  useCount: number;
}
export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target?: string;
  outcome: string;
  details?: Record<string, unknown>;
}
export interface HistoryItem {
  id: string;
  request: string;
  language?: string;
  status: string;
  summary: string;
  agents: string[];
  startedAt: string;
  finishedAt: string;
}
export interface ToolInfo {
  id: string;
  title: string;
  description: string;
  module: string;
  categories: string[];
  status: Capability;
}
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  tools: string[];
  usesModel: boolean;
  stats: { runs: number; failures: number };
}
export type ServerMessage =
  | { kind: 'hello'; version: string; pendingPermissions: PermissionRequest[] }
  | { kind: 'bus'; event: AgentEvent }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'permission.resolved'; id: string; decision: string }
  | { kind: 'audit'; entry: AuditEntry }
  | { kind: 'agent'; agent: Pick<AgentInfo, 'id' | 'health' | 'metrics' | 'activeTasks'> }
  | { kind: 'request.done'; result: RequestResult }
  | { kind: 'request.error'; requestId: string; code: string; message: string }
  | { kind: 'license'; status: LicenseStatus };
