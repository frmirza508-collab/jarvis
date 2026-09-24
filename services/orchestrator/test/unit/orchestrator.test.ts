import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import type { ChatRequest } from '@jarvis/model-router';
import { createJarvisCore } from '../../src/core.js';
import { ScriptedProvider } from '../../../../tests/helpers/fake-provider.js';

const sys = (r: ChatRequest) => String(r.messages[0]?.content ?? '');
const hasToolResult = (r: ChatRequest) => r.messages.some((m) => m.role === 'tool');

function makeCore(
  script: ConstructorParameters<typeof ScriptedProvider>[0],
  extra: Parameters<typeof createJarvisCore>[0] = {},
) {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'jarvis-orch-'));
  const provider = new ScriptedProvider(script);
  const confirm = vi.fn(async () => 'allow_once' as const);
  const core = createJarvisCore({
    extraProviders: [provider],
    confirm,
    settings: { workspace: ws },
    ...extra,
  });
  return { core, provider, ws, confirm };
}

describe('orchestrator', () => {
  it('registers 70+ specialists with typed definitions', () => {
    const { core } = makeCore(() => '');
    expect(core.registry.size()).toBeGreaterThanOrEqual(70);
    for (const a of core.registry.list())
      for (const t of a.def.tools) expect(core.tools.get(t), `${a.def.id} -> ${t}`).toBeDefined();
    for (const a of core.registry.list())
      for (const s of a.def.skills) expect(core.skills.get(s), `${a.def.id} -> ${s}`).toBeDefined();
  });

  it('plans, delegates in parallel, reviews, verifies files and learns', async () => {
    const { core, ws, provider } = makeCore((r) => {
      const s = sys(r);
      if (s.includes('planning core'))
        return JSON.stringify({
          mode: 'delegate',
          language: 'en',
          tasks: [
            {
              id: 't1',
              agent: 'file-operations',
              goal: 'Create notes.txt with the word alpha',
              dependsOn: [],
              review: false,
            },
            {
              id: 't2',
              agent: 'business-analyst',
              goal: 'Summarise the benefits of alpha',
              dependsOn: [],
              review: false,
            },
            {
              id: 't3',
              agent: 'documentation',
              goal: 'Write summary.md combining results',
              dependsOn: ['t1', 't2'],
              review: true,
            },
          ],
        });
      if (s.includes('File Operations Agent'))
        return hasToolResult(r)
          ? 'Created notes.txt'
          : {
              toolCalls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'fs__write',
                    arguments: JSON.stringify({ path: 'notes.txt', content: 'alpha' }),
                  },
                },
              ],
            };
      if (s.includes('Business Analyst')) return 'Alpha is fast.';
      if (s.includes('Documentation Agent'))
        return hasToolResult(r)
          ? 'Wrote summary.md'
          : {
              toolCalls: [
                {
                  id: 'c2',
                  type: 'function',
                  function: {
                    name: 'fs__write',
                    arguments: JSON.stringify({ path: 'summary.md', content: '# Alpha\nAlpha is fast.' }),
                  },
                },
              ],
            };
      if (s.includes('Review the deliverable')) return JSON.stringify({ approved: true, issues: [] });
      if (s.includes('Present ONE concise final answer'))
        return 'All done: notes.txt and summary.md created.';
      if (s.includes('reusable, general lesson'))
        return JSON.stringify({ lesson: 'Create source files before summarising them.' });
      return 'unexpected';
    });
    const events: string[] = [];
    core.bus.onAny((e) => events.push(e.type));
    const res = await core.orchestrator.handle({ text: 'Make notes and a summary about alpha' });
    expect(res.status).toBe('succeeded');
    expect(res.reply).toContain('summary.md');
    expect(res.verification.ok).toBe(true);
    expect(existsSync(path.join(ws, 'notes.txt'))).toBe(true);
    expect(existsSync(path.join(ws, 'summary.md'))).toBe(true);
    expect(res.agents).toEqual(
      expect.arrayContaining(['file-operations', 'business-analyst', 'documentation']),
    );
    for (const t of [
      'TASK_REQUEST',
      'TASK_ACCEPTED',
      'TASK_PROGRESS',
      'TASK_RESULT',
      'REVIEW_REQUEST',
      'REVIEW_RESULT',
      'COMPLETED',
    ])
      expect(events).toContain(t);
    expect(core.registry.get('file-operations')!.metrics.tasksSucceeded).toBe(1);
    // parallel: t1 and t2 planned without dependencies; t3 must see both upstream results
    const docCall = provider.calls.find((c) => sys(c).includes('Documentation Agent'))!;
    expect(String(docCall.messages[1]!.content)).toContain('Result of t1');
    expect(String(docCall.messages[1]!.content)).toContain('Result of t2');
    await vi.waitFor(() => expect(core.memory.verifiedLessons('summarising')).toHaveLength(1));
    expect(core.memory.taskHistory()[0]!.status).toBe('succeeded');
  });

  it('re-runs a task with reviewer corrections when review fails', async () => {
    let reviews = 0;
    const { core } = makeCore((r) => {
      const s = sys(r);
      if (s.includes('planning core'))
        return JSON.stringify({
          mode: 'delegate',
          tasks: [{ id: 'a', agent: 'copywriting', goal: 'Write a slogan', review: true }],
        });
      if (s.includes('Copywriting Agent'))
        return String(r.messages[1]!.content).includes('reviewer found') ? 'Fast. Reliable. Alpha.' : 'alpha';
      if (s.includes('Review the deliverable'))
        return JSON.stringify(
          reviews++ === 0 ? { approved: false, issues: ['Too short'] } : { approved: true, issues: [] },
        );
      if (s.includes('Present ONE')) return 'Slogan: Fast. Reliable. Alpha.';
      return JSON.stringify({ lesson: null });
    });
    const res = await core.orchestrator.handle({ text: 'slogan please' });
    expect(res.outputs.a!.summary).toBe('Fast. Reliable. Alpha.');
    expect(core.registry.get('copywriting')!.metrics.reviewCorrections).toBe(1);
  });

  it('answers directly for simple requests in the user language', async () => {
    const { core, provider } = makeCore((r) =>
      sys(r).includes('planning core')
        ? JSON.stringify({ mode: 'direct', language: 'ur' })
        : 'جی، میں مدد کر سکتا ہوں۔',
    );
    const res = await core.orchestrator.handle({ text: 'کیا آپ میری مدد کر سکتے ہیں؟' });
    expect(res.language).toBe('ur');
    expect(res.reply).toContain('مدد');
    expect(sys(provider.calls[1]!)).toContain('Urdu');
  });

  it('denied permissions are reported, not faked', async () => {
    const { core } = makeCore(
      (r) => {
        const s = sys(r);
        if (s.includes('planning core'))
          return JSON.stringify({
            mode: 'delegate',
            tasks: [{ id: 'x', agent: 'file-operations', goal: 'delete old.txt' }],
          });
        if (s.includes('File Operations Agent')) {
          const toolMsg = r.messages.find((m) => m.role === 'tool');
          if (toolMsg) return `Could not delete: ${String(toolMsg.content)}`;
          return {
            toolCalls: [
              {
                id: 'd',
                type: 'function',
                function: { name: 'fs__delete', arguments: JSON.stringify({ path: 'old.txt' }) },
              },
            ],
          };
        }
        if (s.includes('Present ONE')) return 'I could not delete old.txt because permission was denied.';
        return JSON.stringify({ lesson: null });
      },
      { confirm: async () => 'deny' },
    );
    const blocked: string[] = [];
    core.bus.on('BLOCKED', (e) => blocked.push(e.payload.reason));
    const res = await core.orchestrator.handle({ text: 'delete old.txt' });
    expect(res.outputs.x!.summary).toContain('PERMISSION_DENIED');
    expect(blocked.length).toBe(1);
  });

  it('prevents agents from using tools outside their allow-list', async () => {
    const { core } = makeCore((r) => {
      const s = sys(r);
      if (s.includes('planning core'))
        return JSON.stringify({
          mode: 'delegate',
          tasks: [{ id: 'x', agent: 'copywriting', goal: 'run a command' }],
        });
      if (s.includes('Copywriting Agent'))
        return hasToolResult(r)
          ? String(r.messages.at(-1)!.content)
          : {
              toolCalls: [
                {
                  id: 'z',
                  type: 'function',
                  function: { name: 'shell__run', arguments: '{"command":"echo hi"}' },
                },
              ],
            };
      return 'ok';
    });
    const res = await core.orchestrator.handle({ text: 'x' });
    expect(res.outputs.x!.summary).toContain('may not use shell.run');
  });

  it('blocks execution without an active entitlement', async () => {
    const { core } = makeCore(() => '', {
      hooks: { checkEntitlement: () => ({ premium: false, reason: 'Subscription expired' }) },
    });
    await expect(core.orchestrator.handle({ text: 'hi' })).rejects.toMatchObject({
      code: 'LICENSE_REQUIRED',
    });
  });

  it('supports cancellation of in-flight requests', async () => {
    const { core } = makeCore(() => new Promise(() => {}) as never);
    // Provider that never resolves unless aborted
    const slow = {
      id: 'openrouter',
      isConfigured: () => true,
      listModels: async () => [],
      chat: (r: ChatRequest) =>
        new Promise<never>((_, rej) =>
          r.signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          ),
        ),
    };
    core.router.register(slow);
    const p = core.orchestrator.handle({ text: 'long task' });
    await vi.waitFor(() => expect(core.orchestrator.activeRequests()).toHaveLength(1));
    core.orchestrator.cancel(core.orchestrator.activeRequests()[0]!);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(core.memory.taskHistory()[0]!.status).toBe('cancelled');
  });

  it('creates validated dynamic agents', async () => {
    const { core } = makeCore(() =>
      JSON.stringify({
        id: 'urdu-poet',
        name: 'Urdu Poetry Agent',
        department: 'design',
        description: 'Writes Urdu poetry in classical forms.',
        capabilities: ['poetry'],
        tools: ['fs.write'],
        skills: [],
        permissions: ['WRITE'],
        modelRole: 'reasoning',
        instructions: 'Write ghazals and nazms in Urdu script with correct meter.',
      }),
    );
    const def = await core.orchestrator.createAgent('an agent that writes Urdu poetry');
    expect(def.id).toBe('urdu-poet');
    expect(core.registry.get('urdu-poet')!.def.dynamic).toBe(true);
    expect(core.registry.findByCapability('poetry')[0]!.def.id).toBe('urdu-poet');
  });

  it('reports honest capability status without keys', () => {
    const core = createJarvisCore();
    const caps = core.capabilities();
    expect(caps.find((c) => c.id === 'models')!.state).toBe('not_configured');
    expect(caps.find((c) => c.id === 'module.computer-control')!.state).toBe(
      process.platform === 'win32' ? 'active' : 'unsupported',
    );
  });
});
