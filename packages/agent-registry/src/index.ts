import { z } from 'zod';
import { emptyMetrics, successRate, type OperationalMetrics, type PermissionCategory, PERMISSION_CATEGORIES } from '@jarvis/shared';

export const DEPARTMENTS = [
  'executive',
  'engineering',
  'research',
  'design',
  'marketing',
  'business',
  'security',
  'knowledge-ai',
  'qa-operations',
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const AgentDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(2),
  department: z.enum(DEPARTMENTS),
  description: z.string().min(10),
  capabilities: z.array(z.string()).min(1),
  tools: z.array(z.string()),
  skills: z.array(z.string()),
  permissions: z.array(z.enum(PERMISSION_CATEGORIES)),
  modelRole: z.enum(['fast', 'reasoning', 'coding', 'vision']),
  instructions: z.string().min(20),
  reviewer: z.string().optional(),
  /** Dynamically created agents are persisted separately and can be removed. */
  dynamic: z.boolean().default(false),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type AgentDefinitionInput = z.input<typeof AgentDefinitionSchema>;

export type AgentLifecycle = 'registered' | 'idle' | 'busy' | 'degraded' | 'disabled';

export interface AgentHealth {
  state: AgentLifecycle;
  consecutiveFailures: number;
  lastError?: string;
  /** Tools the agent needs that are not currently active. */
  unavailableTools: string[];
}

export interface AgentRecord {
  def: AgentDefinition;
  health: AgentHealth;
  metrics: OperationalMetrics;
  activeTasks: number;
}

export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();
  private listeners = new Set<(r: AgentRecord) => void>();

  constructor(private readonly degradeAfterFailures = 3) {}

  register(input: AgentDefinitionInput): AgentRecord {
    const def = AgentDefinitionSchema.parse(input);
    if (this.agents.has(def.id)) throw new Error(`Agent already registered: ${def.id}`);
    const rec: AgentRecord = {
      def,
      health: { state: 'idle', consecutiveFailures: 0, unavailableTools: [] },
      metrics: emptyMetrics(),
      activeTasks: 0,
    };
    this.agents.set(def.id, rec);
    this.emit(rec);
    return rec;
  }

  unregister(id: string): boolean {
    const r = this.agents.get(id);
    if (!r || !r.def.dynamic) return false; // built-in agents cannot be removed, only disabled
    return this.agents.delete(id);
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  list(filter?: { department?: Department }): AgentRecord[] {
    const all = [...this.agents.values()];
    return filter?.department ? all.filter((a) => a.def.department === filter.department) : all;
  }

  size(): number {
    return this.agents.size;
  }

  onChange(fn: (r: AgentRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(r: AgentRecord): void {
    for (const l of this.listeners) l(r);
  }

  setEnabled(id: string, enabled: boolean): void {
    const r = this.agents.get(id);
    if (!r) return;
    r.health.state = enabled ? 'idle' : 'disabled';
    this.emit(r);
  }

  setUnavailableTools(id: string, tools: string[]): void {
    const r = this.agents.get(id);
    if (!r) return;
    r.health.unavailableTools = tools;
    this.emit(r);
  }

  /** Find agents providing a capability, best operational track record first. */
  findByCapability(capability: string): AgentRecord[] {
    return this.list()
      .filter((a) => a.health.state !== 'disabled' && a.def.capabilities.includes(capability))
      .sort((a, b) => (successRate(b.metrics) ?? 0.5) - (successRate(a.metrics) ?? 0.5) || a.activeTasks - b.activeTasks);
  }

  markStart(id: string): void {
    const r = this.agents.get(id);
    if (!r) return;
    r.activeTasks++;
    r.metrics.tasksStarted++;
    r.metrics.lastActiveAt = new Date().toISOString();
    if (r.health.state !== 'disabled') r.health.state = 'busy';
    this.emit(r);
  }

  markEnd(id: string, outcome: { ok: boolean; latencyMs: number; toolErrors?: number; error?: string; corrected?: boolean }): void {
    const r = this.agents.get(id);
    if (!r) return;
    r.activeTasks = Math.max(0, r.activeTasks - 1);
    r.metrics.totalLatencyMs += outcome.latencyMs;
    r.metrics.toolErrors += outcome.toolErrors ?? 0;
    if (outcome.corrected) r.metrics.reviewCorrections++;
    if (outcome.ok) {
      r.metrics.tasksSucceeded++;
      r.health.consecutiveFailures = 0;
    } else {
      r.metrics.tasksFailed++;
      r.health.consecutiveFailures++;
      r.health.lastError = outcome.error;
    }
    if (r.health.state !== 'disabled') {
      r.health.state =
        r.health.consecutiveFailures >= this.degradeAfterFailures ? 'degraded' : r.activeTasks > 0 ? 'busy' : 'idle';
    }
    this.emit(r);
  }

  recordCorrection(id: string): void {
    const r = this.agents.get(id);
    if (!r) return;
    r.metrics.reviewCorrections++;
    this.emit(r);
  }

  permissionsOf(id: string): PermissionCategory[] {
    return this.agents.get(id)?.def.permissions ?? [];
  }
}
