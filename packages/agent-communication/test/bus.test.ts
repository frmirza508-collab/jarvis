import { describe, expect, it } from 'vitest';
import { AgentBus } from '../src/index.js';

describe('agent bus', () => {
  it('delivers typed events by type, task and recipient', async () => {
    const bus = new AgentBus();
    const seen: string[] = [];
    bus.on('TASK_PROGRESS', (e) => seen.push(`type:${e.payload.message}`));
    bus.onTask('t1', (e) => seen.push(`task:${e.type}`));
    bus.onRecipient('seo', (e) => seen.push(`to:${e.type}`));
    bus.publish({
      type: 'TASK_REQUEST',
      from: 'orchestrator',
      to: 'seo',
      taskId: 't1',
      payload: { taskId: 't1', goal: 'audit', requestedBy: 'u' },
    });
    bus.publish({
      type: 'TASK_PROGRESS',
      from: 'seo',
      taskId: 't1',
      payload: { message: 'half', percent: 50 },
    });
    expect(seen).toEqual(['task:TASK_REQUEST', 'to:TASK_REQUEST', 'type:half', 'task:TASK_PROGRESS']);
    expect(bus.getHistory({ taskId: 't1' })).toHaveLength(2);
  });
  it('rejects unknown event types and waits for events', async () => {
    const bus = new AgentBus();
    expect(() =>
      bus.publish({ type: 'NOPE' as 'BLOCKED', from: 'x', taskId: 't', payload: { reason: 'r' } }),
    ).toThrow();
    const p = bus.waitFor('COMPLETED', (e) => e.taskId === 'z', 1000);
    bus.publish({
      type: 'COMPLETED',
      from: 'a',
      taskId: 'z',
      payload: { summary: 'done', artifacts: [], evidence: [] },
    });
    expect((await p).payload.summary).toBe('done');
  });
});
