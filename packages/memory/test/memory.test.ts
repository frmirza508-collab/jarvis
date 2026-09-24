import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/index.js';

describe('memory store', () => {
  it('stores and searches across English, Urdu and Chinese', () => {
    const m = new MemoryStore();
    m.remember({ scope: 'knowledge', content: 'The quarterly SEO report lives in D:\\Reports' });
    m.remember({ scope: 'knowledge', content: 'صارف کو مختصر جوابات پسند ہیں' });
    m.remember({ scope: 'knowledge', content: '用户喜欢简洁的回答' });
    expect(m.search('quarterly')[0]!.content).toContain('SEO');
    expect(m.search('مختصر')).toHaveLength(1);
    expect(m.search('简洁')).toHaveLength(1); // 2-char query uses LIKE fallback
  });
  it('redacts secrets before storage', () => {
    const m = new MemoryStore();
    const it = m.remember({
      scope: 'global',
      content: 'my key is sk-or-v1-abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(it.content).not.toContain('abcdefghijklmnop');
  });
  it('only reuses lessons after verification', () => {
    const m = new MemoryStore();
    const l = m.proposeLesson('For competitor research, collect pricing pages first', 'test');
    expect(m.verifiedLessons('competitor')).toHaveLength(0);
    m.verifyLesson(l.id, 'task passed');
    expect(m.verifiedLessons('competitor')).toHaveLength(1);
  });
  it('supports preferences, retention and crash recovery', () => {
    const m = new MemoryStore();
    m.setPreference('voice.language', 'ur');
    expect(m.getPreference('voice.language')).toBe('ur');
    m.remember({ scope: 'session', content: 'temp', ttlDays: -1 });
    expect(m.purge({ expiredOnly: true })).toBe(1);
    const now = new Date().toISOString();
    m.recordTask({
      id: 't',
      request: 'r',
      status: 'running',
      summary: '',
      agents: [],
      startedAt: now,
      finishedAt: now,
    });
    expect(m.markInterruptedTasks()).toBe(1);
    expect(m.taskHistory()[0]!.status).toBe('interrupted');
  });
});
