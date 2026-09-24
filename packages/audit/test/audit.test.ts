import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { AuditLog } from '../src/index.js';

describe('audit log', () => {
  it('chains hashes, persists, reloads and detects tampering', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'jarvis-audit-')), 'audit.jsonl');
    const log = new AuditLog(file);
    log.record({ actor: 'user', action: 'a', outcome: 'info' });
    log.record({ actor: 'agent', action: 'b', outcome: 'success', details: { apiKey: 'secret' } });
    expect(log.verify()).toBe(-1);
    expect(readFileSync(file, 'utf8')).not.toContain('"secret"');
    const reloaded = new AuditLog(file);
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.verify()).toBe(-1);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    lines[0] = lines[0]!.replace('"actor":"user"', '"actor":"attacker"');
    writeFileSync(file, lines.join('\n') + '\n');
    expect(new AuditLog(file).verify()).toBe(0);
  });
});
