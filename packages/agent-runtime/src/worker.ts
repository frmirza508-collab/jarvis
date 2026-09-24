import {
  JarvisError,
  toJarvisError,
  type Artifact,
  type Evidence,
  type TaskOutput,
  type TaskSpec,
} from '@jarvis/shared';
import type { AgentBus } from '@jarvis/agent-communication';
import type { AgentDefinition, AgentRegistry } from '@jarvis/agent-registry';
import type { ChatMessage, ModelRouter, ToolSchema } from '@jarvis/model-router';
import { ToolRuntime } from '@jarvis/tool-runtime';
import type { SkillRegistry } from '@jarvis/skills';
import type { MemoryStore } from '@jarvis/memory';
import { UNTRUSTED_CONTENT_POLICY, redact, wrapUntrusted } from '@jarvis/security';
import { z } from 'zod';

export interface WorkerDeps {
  bus: AgentBus;
  registry: AgentRegistry;
  router: ModelRouter;
  tools: ToolRuntime;
  skills: SkillRegistry;
  memory: MemoryStore;
  workspace?: string;
}

export interface WorkerRunOptions {
  signal: AbortSignal;
  language: string;
  /** Outputs of upstream tasks. */
  context?: Record<string, TaskOutput>;
  /** Issues from a failed review to correct. */
  corrections?: string[];
  maxIterations?: number;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ur: 'Urdu',
  zh: 'Mandarin Chinese (simplified characters)',
};

const UNTRUSTED_TOOLS = new Set([
  'web.fetch',
  'web.search',
  'browser.open',
  'browser.extract',
  'fs.read',
  'computer.clipboard_read',
  'computer.inspect',
  'shell.run',
]);

function skillFunctionName(id: string): string {
  return `skill__${id.replace(/\./g, '_')}`;
}

function collectArtifacts(toolId: string, out: unknown, artifacts: Artifact[], evidence: Evidence[]): void {
  if (!out || typeof out !== 'object') return;
  const o = out as Record<string, unknown>;
  if (
    typeof o.path === 'string' &&
    /^(fs\.write|fs\.copy|fs\.move|documents\.pdf|browser\.screenshot|browser\.download|computer\.screenshot|skill)/.test(
      toolId,
    )
  )
    artifacts.push({ kind: 'file', label: toolId, value: o.path });
  if (typeof o.url === 'string' && /^(web\.fetch|browser\.open)/.test(toolId))
    evidence.push({
      source: o.url,
      excerpt: typeof o.title === 'string' ? o.title : undefined,
      verified: false,
    });
  if (Array.isArray(out) && toolId === 'web.search')
    for (const r of out as Array<{ url?: string; title?: string }>)
      if (r.url) evidence.push({ source: r.url, excerpt: r.title, verified: false });
  if (Array.isArray(o.sources))
    for (const s of o.sources as Array<{ url?: string; title?: string }>)
      if (s.url) evidence.push({ source: s.url, excerpt: s.title, verified: false });
}

/**
 * Runs one specialist on one typed task: a bounded tool-calling loop over the
 * agent's allowed tools and skills, with progress events, cancellation,
 * permission-gated tools and typed output.
 */
export class AgentWorker {
  constructor(private readonly deps: WorkerDeps) {}

  private toolSchemas(def: AgentDefinition): ToolSchema[] {
    const toolSchemas = this.deps.tools.schemas(def.tools);
    const skillSchemas: ToolSchema[] = def.skills
      .map((id) => this.deps.skills.get(id))
      .filter(
        (s): s is NonNullable<typeof s> =>
          !!s && s.tools.every((t) => this.deps.tools.statusOf(t).state === 'active'),
      )
      .map((s) => ({
        type: 'function' as const,
        function: {
          name: skillFunctionName(s.id),
          description: `[skill] ${s.description}`,
          parameters: z.toJSONSchema(s.input) as Record<string, unknown>,
        },
      }));
    return [...toolSchemas, ...skillSchemas];
  }

  systemPrompt(def: AgentDefinition, language: string, lessons: string[], memories: string[]): string {
    return [
      def.instructions,
      `You are part of JARVIS, a Windows desktop assistant. The user speaks ${LANGUAGE_NAMES[language] ?? language}; write user-facing text in that language.`,
      UNTRUSTED_CONTENT_POLICY,
      'Protected actions trigger a permission prompt shown to the user. If a tool returns PERMISSION_DENIED, do not retry the same action; report it.',
      'Never claim you performed an action unless a tool result confirms it. If you cannot complete the task, say exactly what is missing.',
      lessons.length ? `Verified lessons from past tasks:\n- ${lessons.join('\n- ')}` : '',
      memories.length ? `Relevant memory:\n- ${memories.join('\n- ')}` : '',
      `Current date: ${new Date().toISOString().slice(0, 10)}. Workspace: ${this.deps.workspace ?? process.cwd()}.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  async run(agentId: string, task: TaskSpec, opts: WorkerRunOptions): Promise<TaskOutput> {
    const { bus, registry, router, tools, skills, memory } = this.deps;
    const rec = registry.get(agentId);
    if (!rec) throw new JarvisError('NOT_FOUND', `Unknown agent ${agentId}`);
    if (rec.health.state === 'disabled')
      throw new JarvisError('PERMISSION_DENIED', `Agent ${agentId} is disabled`);
    const def = rec.def;
    const started = Date.now();
    registry.markStart(agentId);
    bus.publish({ type: 'TASK_ACCEPTED', from: agentId, taskId: task.taskId, payload: { agentId } });

    let toolErrors = 0;
    const artifacts: Artifact[] = [];
    const evidence: Evidence[] = [];
    try {
      const lessons = memory.verifiedLessons(task.goal, 5).map((l) => l.content);
      const memories = memory
        .search(task.goal, { scopes: ['preference', 'project', 'knowledge', 'agent', 'global'], limit: 5 })
        .map((m) => m.content);
      const upstream = Object.entries(opts.context ?? {}).map(
        ([id, o]) =>
          `Result of ${id}: ${o.summary}${o.artifacts.length ? `\nArtifacts: ${o.artifacts.map((a) => a.value).join(', ')}` : ''}${o.data ? `\nData: ${JSON.stringify(o.data).slice(0, 6000)}` : ''}`,
      );
      const messages: ChatMessage[] = [
        { role: 'system', content: this.systemPrompt(def, opts.language, lessons, memories) },
        {
          role: 'user',
          content: [
            `Task: ${task.goal}`,
            task.input ? `Input: ${JSON.stringify(task.input)}` : '',
            upstream.length ? `Upstream results:\n${upstream.join('\n\n')}` : '',
            opts.corrections?.length
              ? `A reviewer found these issues in your previous attempt; fix them:\n- ${opts.corrections.join('\n- ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ];
      const schemas = this.toolSchemas(def);
      const maxIter = opts.maxIterations ?? 12;
      for (let iter = 0; iter < maxIter; iter++) {
        if (opts.signal.aborted) throw new JarvisError('CANCELLED', 'Task cancelled');
        const res = await router.chat(def.modelRole, {
          messages,
          tools: schemas.length ? schemas : undefined,
          signal: opts.signal,
          temperature: 0.2,
        });
        if (!res.toolCalls.length) {
          const output: TaskOutput = { summary: res.content.trim(), artifacts, evidence };
          registry.markEnd(agentId, { ok: true, latencyMs: Date.now() - started, toolErrors });
          bus.publish({ type: 'TASK_RESULT', from: agentId, taskId: task.taskId, payload: output });
          return output;
        }
        messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          const fname = call.function.name;
          let args: unknown = {};
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            args = {};
          }
          let content: string;
          if (fname.startsWith('skill__')) {
            const skill = skills.list().find((s) => skillFunctionName(s.id) === fname);
            bus.publish({
              type: 'TASK_PROGRESS',
              from: agentId,
              taskId: task.taskId,
              payload: { message: `Running skill ${skill?.name ?? fname}` },
            });
            try {
              if (!skill || !def.skills.includes(skill.id))
                throw new JarvisError('PERMISSION_DENIED', `Skill not allowed: ${fname}`);
              const out = await skills.run(skill.id, args, {
                actor: agentId,
                signal: opts.signal,
                workspace: this.deps.workspace,
                llm: async (prompt, o) =>
                  (
                    await router.chat(o?.role ?? 'reasoning', {
                      signal: opts.signal,
                      responseFormat: o?.json ? 'json_object' : undefined,
                      messages: [
                        ...(o?.system ? [{ role: 'system' as const, content: o.system }] : []),
                        { role: 'user', content: prompt },
                      ],
                    })
                  ).content,
                progress: (m) =>
                  bus.publish({
                    type: 'TASK_PROGRESS',
                    from: agentId,
                    taskId: task.taskId,
                    payload: { message: m },
                  }),
              });
              collectArtifacts('skill', out, artifacts, evidence);
              content = JSON.stringify(redact(out)).slice(0, 40_000);
            } catch (e) {
              toolErrors++;
              const je = toJarvisError(e);
              content = JSON.stringify({ error: je.code, message: je.message });
            }
          } else {
            const toolId = ToolRuntime.toolIdFromFunctionName(fname);
            bus.publish({
              type: 'TASK_PROGRESS',
              from: agentId,
              taskId: task.taskId,
              payload: { message: `Using ${tools.get(toolId)?.title ?? toolId}` },
            });
            try {
              if (!def.tools.includes(toolId))
                throw new JarvisError('PERMISSION_DENIED', `Agent ${agentId} may not use ${toolId}`);
              const out = await tools.invoke(toolId, args, {
                actor: agentId,
                signal: opts.signal,
                workspace: this.deps.workspace,
              });
              collectArtifacts(toolId, out, artifacts, evidence);
              let text = JSON.stringify(redact(out));
              if (UNTRUSTED_TOOLS.has(toolId)) {
                const o = out as { forModel?: string };
                text =
                  o && typeof o === 'object' && typeof o.forModel === 'string'
                    ? o.forModel
                    : wrapUntrusted(toolId, text);
              }
              content = text.slice(0, 40_000);
            } catch (e) {
              toolErrors++;
              const je = toJarvisError(e);
              if (je.code === 'PERMISSION_DENIED')
                bus.publish({
                  type: 'BLOCKED',
                  from: agentId,
                  taskId: task.taskId,
                  payload: { reason: je.message },
                });
              content = JSON.stringify({ error: je.code, message: je.message });
            }
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
      throw new JarvisError('TIMEOUT', `Agent ${agentId} exceeded ${maxIter} reasoning steps`);
    } catch (e) {
      const je = toJarvisError(e);
      registry.markEnd(agentId, {
        ok: false,
        latencyMs: Date.now() - started,
        toolErrors,
        error: je.message,
      });
      bus.publish({
        type: 'TASK_FAILED',
        from: agentId,
        taskId: task.taskId,
        payload: {
          error: je.message,
          code: je.code,
          retryable: je.code === 'PROVIDER_ERROR' || je.code === 'TIMEOUT',
        },
      });
      throw je;
    }
  }
}
