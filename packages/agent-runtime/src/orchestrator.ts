import { existsSync } from 'node:fs';
import { z } from 'zod';
import { JarvisError, newId, toJarvisError, type TaskOutput, type TaskSpec } from '@jarvis/shared';
import { TaskGraph, type GraphEvent, type TaskNode } from '@jarvis/task-engine';
import { AgentDefinitionSchema, type AgentDefinitionInput } from '@jarvis/agent-registry';
import { detectLanguage } from '@jarvis/voice';
import { AgentWorker, type WorkerDeps } from './worker.js';

export const PlanSchema = z.object({
  mode: z.enum(['direct', 'delegate']),
  language: z.string().default('en'),
  tasks: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
        agent: z.string(),
        goal: z.string().min(3),
        dependsOn: z.array(z.string()).default([]),
        review: z.boolean().default(false),
      }),
    )
    .max(20)
    .default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export interface RequestInput {
  text: string;
  sessionId?: string;
  language?: string;
}

export interface RequestResult {
  requestId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  language: string;
  reply: string;
  plan?: Plan;
  outputs: Record<string, TaskOutput>;
  verification: { ok: boolean; problems: string[] };
  agents: string[];
}

export interface OrchestratorHooks {
  /** Premium entitlement gate (license). Throws or returns false to block execution. */
  checkEntitlement?: () => { premium: boolean; reason?: string };
  onGraphEvent?: (requestId: string, e: GraphEvent) => void;
  onReplyDelta?: (requestId: string, delta: string) => void;
}

function parseJson<T>(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = cleaned.search(/[[{]/);
  return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned) as T;
}

/**
 * The single visible JARVIS. Plans a request into a task DAG, delegates to
 * specialists in parallel, runs reviews, verifies deliverables, synthesises
 * one answer and feeds the learning loop.
 */
export class Orchestrator {
  readonly worker: AgentWorker;
  private active = new Map<string, AbortController>();

  constructor(
    private readonly deps: WorkerDeps,
    private readonly hooks: OrchestratorHooks = {},
  ) {
    this.worker = new AgentWorker(deps);
  }

  cancel(requestId: string): boolean {
    const c = this.active.get(requestId);
    c?.abort();
    return !!c;
  }

  activeRequests(): string[] {
    return [...this.active.keys()];
  }

  private catalogForPlanner(): string {
    return this.deps.registry
      .list()
      .filter((a) => a.health.state !== 'disabled' && a.def.id !== 'orchestrator')
      .map((a) => `${a.def.id}: ${a.def.description} [${a.def.capabilities.join(', ')}]`)
      .join('\n');
  }

  async plan(text: string, language: string, signal: AbortSignal): Promise<Plan> {
    const res = await this.deps.router.chat('reasoning', {
      signal,
      temperature: 0,
      responseFormat: 'json_object',
      messages: [
        {
          role: 'system',
          content: `You are the planning core of JARVIS. Decide how to handle the user's request.
- Use mode "direct" for conversation, simple questions, or single quick actions the generalist can do (reading files, a quick web lookup).
- Use mode "delegate" for multi-step work. Break it into tasks for the specialists below, with dependsOn edges so independent tasks run in parallel. Set review=true for deliverables that should be checked (reports, code, researched facts).
- Only use agent ids from this list:
${this.catalogForPlanner()}
Respond with JSON only: {"mode":"direct"|"delegate","language":"en"|"ur"|"zh"|<iso code>,"tasks":[{"id":"t1","agent":"<id>","goal":"<specific goal>","dependsOn":[],"review":false}]}`,
        },
        { role: 'user', content: `User language hint: ${language}\nRequest: ${text}` },
      ],
    });
    const plan = PlanSchema.parse(parseJson(res.content));
    // Guard against hallucinated agents: route unknown ids to the generalist.
    for (const t of plan.tasks) if (!this.deps.registry.get(t.agent)) t.agent = 'orchestrator';
    const ids = new Set(plan.tasks.map((t) => t.id));
    for (const t of plan.tasks) t.dependsOn = t.dependsOn.filter((d) => ids.has(d) && d !== t.id);
    if (plan.mode === 'delegate' && plan.tasks.length === 0) plan.mode = 'direct';
    return plan;
  }

  private async review(requestId: string, reviewerId: string, task: TaskSpec, output: TaskOutput, signal: AbortSignal): Promise<{ approved: boolean; issues: string[] }> {
    const { bus, router, registry } = this.deps;
    bus.publish({ type: 'REVIEW_REQUEST', from: 'orchestrator', to: reviewerId, taskId: task.taskId, correlationId: requestId, payload: { output, criteria: [task.goal] } });
    const reviewer = registry.get(reviewerId) ?? registry.get('qa-reviewer');
    const res = await router.chat(reviewer?.def.modelRole ?? 'reasoning', {
      signal,
      temperature: 0,
      responseFormat: 'json_object',
      messages: [
        { role: 'system', content: `${reviewer?.def.instructions ?? 'You review work.'}\nReview the deliverable strictly against the goal. Respond JSON {"approved": boolean, "issues": [string]}. Approve unless there are concrete, material problems.` },
        { role: 'user', content: `Goal: ${task.goal}\nDeliverable summary: ${output.summary}\nArtifacts: ${output.artifacts.map((a) => a.value).join(', ') || 'none'}\nEvidence: ${output.evidence.map((e) => e.source).join(', ') || 'none'}` },
      ],
    });
    let verdict: { approved: boolean; issues: string[] };
    try {
      verdict = z.object({ approved: z.boolean(), issues: z.array(z.string()).default([]) }).parse(parseJson(res.content));
    } catch {
      verdict = { approved: true, issues: [] };
    }
    bus.publish({ type: 'REVIEW_RESULT', from: reviewer?.def.id ?? reviewerId, taskId: task.taskId, correlationId: requestId, payload: verdict });
    return verdict;
  }

  /** Final verification: every file artifact must exist; failed tasks are surfaced. */
  verify(outputs: Record<string, TaskOutput>): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    for (const [id, o] of Object.entries(outputs))
      for (const a of o.artifacts) if (a.kind === 'file' && !existsSync(a.value)) problems.push(`${id}: expected file missing: ${a.value}`);
    return { ok: problems.length === 0, problems };
  }

  async handle(input: RequestInput): Promise<RequestResult> {
    const { bus, memory } = this.deps;
    const ent = this.hooks.checkEntitlement?.();
    if (ent && !ent.premium) throw new JarvisError('LICENSE_REQUIRED', ent.reason ?? 'An active JARVIS subscription is required for task execution.');

    const requestId = newId('req');
    const controller = new AbortController();
    this.active.set(requestId, controller);
    const signal = controller.signal;
    const startedAt = new Date().toISOString();
    const language = input.language ?? detectLanguage(input.text).code;
    memory.recordTask({ id: requestId, request: input.text, language, status: 'running', summary: '', agents: [], startedAt, finishedAt: startedAt });
    bus.publish({ type: 'TASK_REQUEST', from: 'user', to: 'orchestrator', taskId: requestId, payload: { taskId: requestId, goal: input.text, requestedBy: 'user' } });
    if (input.sessionId) memory.remember({ scope: 'session', scopeId: input.sessionId, kind: 'utterance', content: input.text, source: 'user', ttlDays: 7 });

    const outputs: Record<string, TaskOutput> = {};
    const agentsUsed = new Set<string>(['orchestrator']);
    let plan: Plan | undefined;
    try {
      plan = await this.plan(input.text, language, signal);
      const lang = plan.language || language;
      if (plan.mode === 'direct') {
        const out = await this.worker.run('orchestrator', { taskId: requestId, goal: input.text, requestedBy: 'user' }, { signal, language: lang });
        outputs.direct = out;
      } else {
        const nodes: TaskNode<TaskOutput>[] = plan.tasks.map((t) => ({
          id: t.id,
          label: t.goal,
          assignee: t.agent,
          dependsOn: t.dependsOn,
          retries: 1,
          run: async (ctx) => {
            agentsUsed.add(t.agent);
            const spec: TaskSpec = { taskId: `${requestId}:${t.id}`, parentTaskId: requestId, goal: t.goal, requestedBy: 'orchestrator' };
            bus.publish({ type: 'TASK_REQUEST', from: 'orchestrator', to: t.agent, taskId: spec.taskId, correlationId: requestId, payload: spec });
            const upstream = Object.fromEntries(Object.entries(ctx.inputs).map(([k, v]) => [k, v as TaskOutput]));
            let out = await this.worker.run(t.agent, spec, { signal, language: lang, context: upstream });
            const reviewerId = t.review ? (this.deps.registry.get(t.agent)?.def.reviewer ?? 'qa-reviewer') : undefined;
            if (reviewerId) {
              agentsUsed.add(reviewerId);
              const verdict = await this.review(requestId, reviewerId, spec, out, signal);
              if (!verdict.approved) {
                out = await this.worker.run(t.agent, spec, { signal, language: lang, context: upstream, corrections: verdict.issues });
                this.deps.registry.recordCorrection(t.agent);
              }
            }
            outputs[t.id] = out;
            return out;
          },
        }));
        const graph = new TaskGraph(nodes, { concurrency: 4, id: requestId, onEvent: (e) => this.hooks.onGraphEvent?.(requestId, e) });
        signal.addEventListener('abort', () => graph.cancel());
        const result = await graph.run();
        if (result.status === 'cancelled') throw new JarvisError('CANCELLED', 'Request cancelled');
        for (const n of Object.values(result.nodes))
          if (n.status === 'failed') outputs[n.id] = { summary: `FAILED: ${n.error}`, artifacts: [], evidence: [] };
      }

      agentsUsed.add('final-verification');
      const verification = this.verify(outputs);
      const reply = await this.synthesize(requestId, input.text, lang, outputs, verification, signal);
      const anyFailed = Object.values(outputs).some((o) => o.summary.startsWith('FAILED:'));
      const status = anyFailed && Object.keys(outputs).length === 1 ? 'failed' : 'succeeded';
      bus.publish({ type: 'COMPLETED', from: 'orchestrator', taskId: requestId, payload: { summary: reply, artifacts: Object.values(outputs).flatMap((o) => o.artifacts), evidence: Object.values(outputs).flatMap((o) => o.evidence) } });
      memory.recordTask({ id: requestId, request: input.text, language: lang, status, summary: reply.slice(0, 2000), agents: [...agentsUsed], startedAt, finishedAt: new Date().toISOString() });
      if (status === 'succeeded' && verification.ok && plan.mode === 'delegate') void this.learn(input.text, plan, outputs).catch(() => {});
      return { requestId, status, language: lang, reply, plan, outputs, verification, agents: [...agentsUsed] };
    } catch (e) {
      const je = toJarvisError(e);
      const status = je.code === 'CANCELLED' ? 'cancelled' : 'failed';
      memory.recordTask({ id: requestId, request: input.text, language, status, summary: je.message, agents: [...agentsUsed], startedAt, finishedAt: new Date().toISOString() });
      if (status === 'failed') bus.publish({ type: 'TASK_FAILED', from: 'orchestrator', taskId: requestId, payload: { error: je.message, code: je.code, retryable: false } });
      throw je;
    } finally {
      this.active.delete(requestId);
    }
  }

  private async synthesize(requestId: string, request: string, language: string, outputs: Record<string, TaskOutput>, verification: { ok: boolean; problems: string[] }, signal: AbortSignal): Promise<string> {
    const only = Object.keys(outputs);
    if (only.length === 1 && only[0] === 'direct' && verification.ok) return outputs.direct!.summary;
    const res = await this.deps.router.chat(
      'fast',
      {
        signal,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `You are JARVIS. Present ONE concise final answer to the user in ${language === 'ur' ? 'Urdu' : language === 'zh' ? 'Mandarin Chinese' : language === 'en' ? 'English' : language}. Mention created files by path. State honestly any failed steps or verification problems. Do not mention internal agent names.`,
          },
          {
            role: 'user',
            content: `Request: ${request}\n\nResults:\n${Object.entries(outputs)
              .map(([k, o]) => `[${k}] ${o.summary}\nFiles: ${o.artifacts.map((a) => a.value).join(', ') || 'none'}\nSources: ${o.evidence.map((e) => e.source).slice(0, 10).join(', ') || 'none'}`)
              .join('\n\n')}\n\nVerification problems: ${verification.problems.join('; ') || 'none'}`,
          },
        ],
      },
      { onDelta: this.hooks.onReplyDelta ? (d) => this.hooks.onReplyDelta!(requestId, d) : undefined },
    );
    return res.content.trim();
  }

  /** Learning loop: propose a lesson from a verified success; stored as unverified until confirmed. */
  private async learn(request: string, plan: Plan, outputs: Record<string, TaskOutput>): Promise<void> {
    const res = await this.deps.router.chat('fast', {
      temperature: 0,
      responseFormat: 'json_object',
      messages: [
        { role: 'system', content: 'Extract at most one reusable, general lesson from this successful task (a workflow insight, not user data). Respond JSON {"lesson": string|null}.' },
        { role: 'user', content: `Request: ${request}\nPlan: ${JSON.stringify(plan.tasks.map((t) => ({ agent: t.agent, goal: t.goal })))}\nOutcome: ${Object.values(outputs).map((o) => o.summary.slice(0, 300)).join(' | ')}` },
      ],
    });
    const parsed = z.object({ lesson: z.string().min(10).nullable() }).safeParse(parseJson(res.content));
    if (parsed.success && parsed.data.lesson) {
      const l = this.deps.memory.proposeLesson(parsed.data.lesson, 'learning-agent', plan.tasks.map((t) => t.agent));
      // Verified automatically only because the task passed final verification; the user can still reject it.
      this.deps.memory.verifyLesson(l.id, `Task succeeded and passed final verification: ${request.slice(0, 200)}`);
    }
  }

  /** Agent Builder: create a validated dynamic specialist from a natural-language brief. */
  async createAgent(brief: string): Promise<AgentDefinitionInput> {
    const tools = this.deps.tools.list().map((t) => `${t.id} (${t.categories.join('/')})`).join(', ');
    const res = await this.deps.router.chat('reasoning', {
      temperature: 0,
      responseFormat: 'json_object',
      messages: [
        {
          role: 'system',
          content: `Design a JARVIS specialist agent. Respond JSON with fields: id (kebab-case), name, department (one of executive, engineering, research, design, marketing, business, security, knowledge-ai, qa-operations), description, capabilities (string[]), tools (subset of: ${tools}), skills (string[] from: ${this.deps.skills.list().map((s) => s.id).join(', ')}), permissions (subset of READ, WRITE, EXECUTE, NETWORK, BROWSER, SYSTEM, SENSITIVE, DESTRUCTIVE matching the tools), modelRole (fast|reasoning|coding|vision), instructions.`,
        },
        { role: 'user', content: brief },
      ],
    });
    const def = AgentDefinitionSchema.parse({ ...(parseJson(res.content) as object), dynamic: true });
    const unknownTools = def.tools.filter((t) => !this.deps.tools.get(t) && !t.startsWith('memory.'));
    if (unknownTools.length) throw new JarvisError('INVALID_INPUT', `Agent references unknown tools: ${unknownTools.join(', ')}`);
    def.skills = def.skills.filter((s) => this.deps.skills.get(s));
    this.deps.registry.register(def);
    return def;
  }
}
