import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import WebSocket from 'ws';
import type { ChatRequest } from '@jarvis/model-router';
import { createJarvisCore } from '../../src/core.js';
import { createServer } from '../../src/server.js';
import { ScriptedProvider } from '../../../../tests/helpers/fake-provider.js';

const TOKEN = 'x'.repeat(48);
let base: string;
let app: Awaited<ReturnType<typeof createServer>>;
let premium = true;
let core: ReturnType<typeof createJarvisCore>;

beforeAll(async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'jarvis-srv-'));
  const sys = (r: ChatRequest) => String(r.messages[0]?.content ?? '');
  const provider = new ScriptedProvider((r) => {
    if (sys(r).includes('planning core')) return JSON.stringify({ mode: 'delegate', tasks: [{ id: 'w', agent: 'file-operations', goal: 'write hello.txt' }] });
    if (sys(r).includes('File Operations Agent'))
      return r.messages.some((m) => m.role === 'tool') ? 'written' : { toolCalls: [{ id: '1', type: 'function', function: { name: 'fs__delete', arguments: JSON.stringify({ path: 'nothing.txt' }) } }] };
    if (sys(r).includes('Present ONE')) return 'finished';
    return JSON.stringify({ lesson: null });
  });
  core = createJarvisCore({ extraProviders: [provider], settings: { workspace: ws }, hooks: { checkEntitlement: () => ({ premium, reason: 'expired' }) } });
  app = await createServer({ core, token: TOKEN, version: 'test' });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await core.shutdown();
});

const call = (method: string, url: string, body?: unknown, token = TOKEN) =>
  fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

describe('local core API', () => {
  it('requires the session token', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await call('GET', '/status', undefined, 'wrong')).status).toBe(401);
    expect((await call('GET', '/status')).status).toBe(200);
  });

  it('rejects foreign browser origins via CORS', async () => {
    const r = await fetch(`${base}/status`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const ok = await fetch(`${base}/status`, { method: 'OPTIONS', headers: { Origin: 'http://tauri.localhost', 'Access-Control-Request-Method': 'GET' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
  });

  it('stores secrets without ever returning values', async () => {
    const put = await call('PUT', '/secrets/BRAVE_SEARCH_API_KEY', { value: 'brave-secret-123456' });
    expect(put.status).toBe(200);
    const list = (await (await call('GET', '/secrets')).json()) as Array<{ name: string; configured: boolean }>;
    expect(list.find((s) => s.name === 'BRAVE_SEARCH_API_KEY')!.configured).toBe(true);
    expect(JSON.stringify(list)).not.toContain('brave-secret');
    expect((await call('PUT', '/secrets/NOT_A_SECRET', { value: '12345678' })).status).toBe(400);
  });

  it('streams events and resolves permission prompts from the UI', async () => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/events?token=${TOKEN}`);
    const messages: Array<Record<string, unknown>> = [];
    await new Promise((r) => socket.once('open', r));
    socket.on('message', async (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      messages.push(m);
      if (m.kind === 'permission') {
        const req = m.request as { id: string; action: string; risk: string };
        expect(req.action).toBe('fs.delete');
        expect(req.risk).toBe('critical');
        await call('POST', `/permissions/${req.id}/decision`, { decision: 'deny' });
      }
    });
    const r = await call('POST', '/requests', { text: 'clean up' });
    expect(r.status).toBe(202);
    const { requestId } = (await r.json()) as { requestId: string };
    await expect.poll(() => messages.some((m) => m.kind === 'request.done'), { timeout: 10_000 }).toBe(true);
    const done = messages.find((m) => m.kind === 'request.done')!.result as { requestId: string; outputs: Record<string, { summary: string }> };
    expect(done.requestId).toBe(requestId);
    expect(messages.some((m) => m.kind === 'permission.resolved' && m.decision === 'deny')).toBe(true);
    expect(messages.some((m) => m.kind === 'bus')).toBe(true);
    expect(messages.some((m) => m.kind === 'audit')).toBe(true);
    socket.close();
  });

  it('WebSocket requires the token', async () => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/events?token=bad`);
    const code = await new Promise<number>((r) => {
      socket.once('unexpected-response', (_req, res) => r(res.statusCode ?? 0));
      socket.once('open', () => r(101));
    });
    expect(code).toBe(401);
  });

  it('returns 402 when the subscription is not active', async () => {
    premium = false;
    const r = await call('POST', '/requests', { text: 'hello' });
    expect(r.status).toBe(402);
    premium = true;
  });

  it('never lets policy auto-allow DESTRUCTIVE', async () => {
    const policy = (await (await call('GET', '/permissions/policy')).json()) as Record<string, unknown>;
    const r = (await (await call('PUT', '/permissions/policy', { ...policy, autoAllow: ['READ', 'DESTRUCTIVE'] })).json()) as { autoAllow: string[] };
    expect(r.autoAllow).toEqual(['READ']);
  });

  it('exposes agents, tools, skills, memory and audit', async () => {
    expect(((await (await call('GET', '/agents')).json()) as unknown[]).length).toBeGreaterThanOrEqual(70);
    expect(((await (await call('GET', '/tools')).json()) as unknown[]).length).toBeGreaterThan(30);
    expect(((await (await call('GET', '/skills')).json()) as unknown[]).length).toBe(5);
    await call('POST', '/memory', { content: 'Prefers Urdu replies', scope: 'preference' });
    expect(((await (await call('GET', '/memory?q=Urdu')).json()) as unknown[]).length).toBe(1);
    const audit = (await (await call('GET', '/audit')).json()) as { chainIntact: boolean };
    expect(audit.chainIntact).toBe(true);
  });
});
