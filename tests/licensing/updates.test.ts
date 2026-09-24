import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJarvisCore } from '../../services/orchestrator/src/core.js';
import { createServer, compareVersions } from '../../services/orchestrator/src/server.js';
import { startLicenseServer } from '../helpers/license-server.js';

let srv: Awaited<ReturnType<typeof startLicenseServer>>;
beforeAll(async () => {
  srv = await startLicenseServer();
});
afterAll(async () => srv.close());

describe('update channel', () => {
  it('compares semantic versions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.0-dev')).toBe(0);
    expect(compareVersions('0.9.9', '0.10.0')).toBeLessThan(0);
  });

  it('publishes a release from admin settings and the desktop core reports it', async () => {
    const sha = 'ab'.repeat(32);
    const bad = await srv.call(
      'PUT',
      '/v1/admin/settings',
      { latestRelease: { version: '0.2.0', url: 'http://insecure.example/x.exe', sha256: sha } },
      srv.adminToken,
    );
    expect(bad.status).toBe(400);
    const ok = await srv.call(
      'PUT',
      '/v1/admin/settings',
      {
        latestRelease: {
          version: '0.2.0',
          url: 'https://downloads.example.com/JARVIS-Setup-0.2.0-x64.exe',
          sha256: sha,
          notes: 'Faster voice',
        },
      },
      srv.adminToken,
    );
    expect(ok.status).toBe(200);
    const core = createJarvisCore();
    const app = await createServer({
      core,
      token: 'k'.repeat(48),
      version: '0.1.0',
      updateServerUrl: srv.address,
    });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const r = (await (
      await fetch(`${base}/updates`, { headers: { Authorization: `Bearer ${'k'.repeat(48)}` } })
    ).json()) as Record<string, unknown>;
    expect(r).toMatchObject({
      current: '0.1.0',
      latest: '0.2.0',
      updateAvailable: true,
      sha256: sha,
      notes: 'Faster voice',
    });
    const blocked = await fetch(`${base}/system/open-url`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${'k'.repeat(48)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///C:/Windows/System32/calc.exe' }),
    });
    expect(blocked.status).toBe(403);
    await app.close();
    await core.shutdown();
  });
});
