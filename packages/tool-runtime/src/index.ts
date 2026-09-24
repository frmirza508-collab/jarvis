import { z } from 'zod';
import {
  JarvisError,
  maxRisk,
  toJarvisError,
  type CapabilityStatus,
  type PermissionCategory,
  type RiskLevel,
} from '@jarvis/shared';
import type { PermissionManager } from '@jarvis/permissions';
import type { AuditLog } from '@jarvis/audit';
import { redact } from '@jarvis/security';

export interface ToolContext {
  actor: string;
  signal?: AbortSignal;
  /** Workspace root for file/terminal tools. */
  workspace?: string;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType, O = unknown> {
  id: string; // e.g. "fs.read"
  title: string;
  description: string;
  module: string;
  categories: PermissionCategory[];
  input: S;
  /** Dynamic risk assessment for a concrete input (e.g. shell command analysis). */
  assess?: (input: z.infer<S>, ctx: ToolContext) => { risk: RiskLevel; target?: string; description?: string; blocked?: boolean; reasons?: string[] };
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<O>;
  /** Honest runtime availability (e.g. unsupported on this OS). */
  status?: () => CapabilityStatus['state'];
  statusReason?: () => string | undefined;
}

export function defineTool<S extends z.ZodType, O>(def: ToolDefinition<S, O>): ToolDefinition<S, O> {
  return def;
}

export interface ToolCallRecord {
  toolId: string;
  actor: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export class ToolRuntime {
  private tools = new Map<string, ToolDefinition>();
  private calls: ToolCallRecord[] = [];

  constructor(
    private readonly permissions: PermissionManager,
    private readonly audit: AuditLog,
  ) {}

  register(tool: ToolDefinition<z.ZodType, unknown>): void {
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, tool);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  statusOf(id: string): CapabilityStatus {
    const t = this.tools.get(id);
    if (!t) return { id, label: id, state: 'planned', reason: 'not implemented' };
    return { id, label: t.title, state: t.status?.() ?? 'active', reason: t.statusReason?.() };
  }

  /** JSON-schema tool list for function-calling models. */
  schemas(ids?: string[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return this.list()
      .filter((t) => (!ids || ids.includes(t.id)) && (t.status?.() ?? 'active') === 'active')
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.id.replace(/\./g, '__'),
          description: `${t.description} [permissions: ${t.categories.join(', ')}]`,
          parameters: z.toJSONSchema(t.input) as Record<string, unknown>,
        },
      }));
  }

  static toolIdFromFunctionName(name: string): string {
    return name.replace(/__/g, '.');
  }

  recentCalls(limit = 200): ToolCallRecord[] {
    return this.calls.slice(-limit);
  }

  async invoke(id: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(id);
    if (!tool) throw new JarvisError('NOT_FOUND', `Unknown tool: ${id}`);
    const state = tool.status?.() ?? 'active';
    if (state !== 'active') throw new JarvisError('UNSUPPORTED_PLATFORM', `${tool.title} is ${state}: ${tool.statusReason?.() ?? ''}`);
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) throw new JarvisError('INVALID_INPUT', `Invalid input for ${id}: ${parsed.error.message}`);
    const input = parsed.data;
    const a = tool.assess?.(input, ctx);
    if (a?.blocked) {
      this.audit.record({ actor: ctx.actor, action: `tool:${id}`, target: a.target, outcome: 'denied', details: { reason: 'blocked', reasons: a.reasons } });
      throw new JarvisError('PERMISSION_DENIED', `Blocked by safety policy: ${(a.reasons ?? []).join(', ')}`);
    }
    const check = await this.permissions.request({
      actor: ctx.actor,
      action: id,
      categories: tool.categories,
      risk: maxRisk(a?.risk ?? 'low'),
      target: a?.target,
      description: a?.description ?? `${tool.title}: ${JSON.stringify(redact(input)).slice(0, 300)}`,
    });
    if (!check.allowed) throw new JarvisError('PERMISSION_DENIED', `Permission denied for ${tool.title}`);
    const started = Date.now();
    try {
      const out = await tool.execute(input, ctx);
      this.calls.push({ toolId: id, actor: ctx.actor, ok: true, latencyMs: Date.now() - started });
      this.audit.record({ actor: ctx.actor, action: `tool:${id}`, target: a?.target, outcome: 'success' });
      return out;
    } catch (e) {
      const je = toJarvisError(e);
      this.calls.push({ toolId: id, actor: ctx.actor, ok: false, latencyMs: Date.now() - started, error: je.message });
      this.audit.record({ actor: ctx.actor, action: `tool:${id}`, target: a?.target, outcome: 'failure', details: { error: je.message } });
      throw je;
    }
  }
}
