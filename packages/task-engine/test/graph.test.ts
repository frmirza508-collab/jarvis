import { describe, expect, it } from 'vitest';
import { TaskGraph, topoSort } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('task graph', () => {
  it('rejects cycles and unknown deps', () => {
    expect(() => topoSort([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])).toThrow(/cycle/);
    expect(() => topoSort([{ id: 'a', dependsOn: ['x'] }])).toThrow(/unknown/);
  });
  it('runs independent nodes in parallel and passes outputs downstream', async () => {
    const started: Record<string, number> = {};
    const g = new TaskGraph([
      { id: 'a', label: 'a', dependsOn: [], run: async () => { started.a = Date.now(); await sleep(80); return 1; } },
      { id: 'b', label: 'b', dependsOn: [], run: async () => { started.b = Date.now(); await sleep(80); return 2; } },
      { id: 'c', label: 'c', dependsOn: ['a', 'b'], run: async (ctx) => (ctx.inputs.a as number) + (ctx.inputs.b as number) },
    ]);
    const r = await g.run();
    expect(r.status).toBe('succeeded');
    expect(r.nodes.c!.output).toBe(3);
    expect(Math.abs(started.a! - started.b!)).toBeLessThan(40);
  });
  it('retries then fails and skips dependents', async () => {
    let attempts = 0;
    const g = new TaskGraph([
      { id: 'a', label: 'a', dependsOn: [], retries: 2, run: async () => { attempts++; throw new Error('boom'); } },
      { id: 'b', label: 'b', dependsOn: ['a'], run: async () => 1 },
    ]);
    const r = await g.run();
    expect(attempts).toBe(3);
    expect(r.status).toBe('failed');
    expect(r.nodes.b!.status).toBe('skipped');
  });
  it('supports cancellation', async () => {
    const g = new TaskGraph([{ id: 'a', label: 'a', dependsOn: [], run: (ctx) => new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))) }]);
    setTimeout(() => g.cancel(), 30);
    expect((await g.run()).status).toBe('cancelled');
  });
});
