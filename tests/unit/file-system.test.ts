import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { FileIndex, fileSystemTools } from '@jarvis/file-system';
import type { ConfirmHandler } from '@jarvis/permissions';
import { makeRuntime } from '../helpers/runtime.js';

function setup(confirm: ConfirmHandler = vi.fn<ConfirmHandler>(async () => 'allow_once')) {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'jarvis-fs-'));
  const rt = makeRuntime(confirm);
  for (const t of fileSystemTools(new FileIndex())) rt.tools.register(t);
  const ctx = { actor: 'file-operations', workspace: ws };
  return { ws, rt, ctx, confirm };
}

describe('file-system tools', () => {
  it('creates, reads, edits, copies, moves and searches files', async () => {
    const { ws, rt, ctx } = setup();
    await rt.tools.invoke('fs.write', { path: 'notes/a.txt', content: 'hello world' }, ctx);
    expect((await rt.tools.invoke('fs.read', { path: 'notes/a.txt' }, ctx)) as { content: string }).toMatchObject({ content: 'hello world' });
    await rt.tools.invoke('fs.edit', { path: 'notes/a.txt', find: 'world', replace: 'JARVIS' }, ctx);
    expect(readFileSync(path.join(ws, 'notes/a.txt'), 'utf8')).toBe('hello JARVIS');
    await rt.tools.invoke('fs.copy', { from: 'notes/a.txt', to: 'notes/b.txt' }, ctx);
    await rt.tools.invoke('fs.move', { from: 'notes/b.txt', to: 'archive/c.txt' }, ctx);
    expect(existsSync(path.join(ws, 'archive/c.txt'))).toBe(true);
    const found = (await rt.tools.invoke('fs.search', { query: 'c.txt', addRoot: '.' }, ctx)) as { results: Array<{ name: string }> };
    expect(found.results[0]!.name).toBe('c.txt');
    const meta = (await rt.tools.invoke('fs.metadata', { path: 'archive/c.txt', hash: true }, ctx)) as { sha256: string };
    expect(meta.sha256).toHaveLength(64);
  });
  it('refuses to overwrite without overwrite flag', async () => {
    const { rt, ctx } = setup();
    await rt.tools.invoke('fs.write', { path: 'x.txt', content: '1' }, ctx);
    await expect(rt.tools.invoke('fs.write', { path: 'x.txt', content: '2' }, ctx)).rejects.toThrow();
  });
  it('requires confirmation for deletion and respects denial', async () => {
    const confirm = vi.fn<ConfirmHandler>(async () => 'deny');
    const { ws, rt, ctx } = setup(confirm);
    writeFileSync(path.join(ws, 'keep.txt'), 'x');
    await expect(rt.tools.invoke('fs.delete', { path: 'keep.txt' }, ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ risk: 'critical', action: 'fs.delete' }));
    expect(existsSync(path.join(ws, 'keep.txt'))).toBe(true);
  });
  it('blocks writes to protected system paths even when the user would allow', async () => {
    const { rt, ctx } = setup();
    const target = process.platform === 'win32' ? 'C:\\Windows\\jarvis.txt' : '/etc/jarvis-test.txt';
    await expect(rt.tools.invoke('fs.write', { path: target, content: 'x' }, ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('audits every tool call', async () => {
    const { rt, ctx } = setup();
    await rt.tools.invoke('fs.list', { path: '.' }, ctx);
    expect(rt.audit.list().some((e) => e.action === 'tool:fs.list' && e.outcome === 'success')).toBe(true);
    expect(rt.audit.verify()).toBe(-1);
  });
});
