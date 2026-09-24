import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { ChatRequest } from '@jarvis/model-router';
import { createJarvisCore } from '../../services/orchestrator/src/core.js';
import { createServer } from '../../services/orchestrator/src/server.js';
import { ScriptedProvider } from '../helpers/fake-provider.js';
import { findChromium } from '../helpers/browser.js';
import { serveDir } from '../helpers/static-server.js';

const exe = findChromium();
const dist = path.resolve(import.meta.dirname, '../../apps/desktop/dist');
const d = exe && existsSync(path.join(dist, 'index.html')) ? describe : describe.skip;
const shots = path.resolve(import.meta.dirname, '../../test-results/desktop');

d('desktop UI (real browser, real local core)', () => {
  let browser: Browser;
  let page: Page;
  let site: Awaited<ReturnType<typeof serveDir>>;
  let app: Awaited<ReturnType<typeof createServer>>;
  let core: ReturnType<typeof createJarvisCore>;
  let ws: string;
  const TOKEN = 't'.repeat(64);
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: true });

  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    ws = mkdtempSync(path.join(os.tmpdir(), 'jarvis-ui-'));
    writeFileSync(path.join(ws, 'old.log'), 'x');
    const sys = (r: ChatRequest) => String(r.messages[0]?.content ?? '');
    const provider = new ScriptedProvider((r) => {
      const s = sys(r);
      const user = String(r.messages[1]?.content ?? '');
      if (s.includes('planning core')) {
        if (user.includes('hello')) return JSON.stringify({ mode: 'direct', language: 'en' });
        return JSON.stringify({ mode: 'delegate', language: 'en', tasks: [{ id: 'clean', agent: 'file-operations', goal: 'Delete old.log in the workspace' }, { id: 'note', agent: 'documentation', goal: 'Write cleanup-report.md', dependsOn: ['clean'] }] });
      }
      if (s.includes('File Operations Agent'))
        return r.messages.some((m) => m.role === 'tool') ? 'Deleted old.log' : { toolCalls: [{ id: 'd1', type: 'function', function: { name: 'fs__delete', arguments: JSON.stringify({ path: 'old.log' }) } }] };
      if (s.includes('Documentation Agent'))
        return r.messages.some((m) => m.role === 'tool') ? 'Report written' : { toolCalls: [{ id: 'w1', type: 'function', function: { name: 'fs__write', arguments: JSON.stringify({ path: 'cleanup-report.md', content: '# Cleanup\nold.log removed' }) } }] };
      if (s.includes('Present ONE')) return 'Cleanup complete: old.log deleted and cleanup-report.md written.';
      if (s.includes('reusable')) return JSON.stringify({ lesson: null });
      return 'Hello! How can I help?';
    });
    core = createJarvisCore({ extraProviders: [provider], settings: { workspace: ws }, hooks: { checkEntitlement: () => ({ premium: true }) } });
    site = await serveDir(dist);
    app = await createServer({ core, token: TOKEN, version: 'ui-test', allowedOrigins: [site.url] });
    const coreUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
    page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
    page.on('requestfailed', (r) => console.error('REQFAIL', r.method(), r.url(), r.failure()?.errorText));
    await page.goto(`${site.url}/?core=${encodeURIComponent(coreUrl)}&token=${TOKEN}`);
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await site?.close();
    await core?.shutdown();
  });

  it('boots the 3D shell and connects to the core', async () => {
    await page.waitForSelector('canvas', { timeout: 30_000 });
    await page.getByText('core connected').waitFor({ timeout: 15_000 });
    await page.getByText('74 agents').waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(shots, '01-command.png') });
    const canvasSize = await page.locator('canvas').boundingBox();
    expect(canvasSize!.width).toBeGreaterThan(1000);
  });

  it('answers a direct request', async () => {
    await page.getByRole('textbox', { name: 'Command' }).fill('hello jarvis');
    await page.keyboard.press('Enter');
    await page.getByText('Hello! How can I help?').waitFor({ timeout: 15_000 }).catch(async (e) => { console.error('LOG>>', await page.locator('.log').innerText()); throw e; });
  });

  it('shows a critical permission prompt, and executes only after approval', async () => {
    await page.getByRole('textbox', { name: 'Command' }).fill('clean up my workspace');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Permission required' }).waitFor({ timeout: 15_000 });
    await expect(page.getByText('Critical — cannot be undone')).toBeTruthy();
    expect(existsSync(path.join(ws, 'old.log'))).toBe(true);
    await page.screenshot({ path: path.join(shots, '02-permission.png') });
    await page.getByRole('button', { name: 'Allow once' }).click();
    // fs.write (medium) also asks because WRITE is not auto-allowed by default
    const second = page.getByRole('button', { name: 'Allow once' });
    await second.waitFor({ timeout: 15_000 });
    await second.click();
    await page.getByText('Cleanup complete').waitFor({ timeout: 20_000 });
    expect(existsSync(path.join(ws, 'old.log'))).toBe(false);
    expect(existsSync(path.join(ws, 'cleanup-report.md'))).toBe(true);
    await page.getByText('cleanup-report.md', { exact: false }).first().waitFor();
  });

  it('navigates the agent constellation', async () => {
    await nav('Agents').click();
    await page.getByText('Agent constellation · 74 specialists').waitFor();
    await page.getByText('File Operations Agent').first().click();
    await page.getByText('Review corrections').waitFor();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(shots, '03-agents.png') });
  });

  it('shows modules with honest capability states', async () => {
    await nav('Modules').click();
    await page.getByText('Modules · tools · skills').waitFor();
    await page.getByText('Configure BRAVE_SEARCH_API_KEY or TAVILY_API_KEY').first().waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(shots, '04-modules.png') });
  });

  it('shows subscription plans in Account', async () => {
    await nav('Account').click();
    await page.getByText('PKR 4,000').waitFor();
    await page.getByText('PKR 40,000').waitFor();
    await page.screenshot({ path: path.join(shots, '05-account.png') });
  });

  it('stores provider keys through Settings without echoing them', async () => {
    await nav('Settings').click();
    await page.getByLabel(/Brave Search API key/).fill('brave-ui-test-key-123');
    await page.locator('.secret-row', { hasText: 'Brave Search' }).getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved securely').waitFor();
    expect(core.secrets.get('BRAVE_SEARCH_API_KEY')).toBe('brave-ui-test-key-123');
    expect(await page.content()).not.toContain('brave-ui-test-key-123');
    await page.screenshot({ path: path.join(shots, '06-settings.png') });
  });

  it('shows history and a verified audit chain in Activity', async () => {
    await nav('Activity').click();
    await page.getByText('chain intact').waitFor();
    await page.getByText('clean up my workspace').first().waitFor();
    await page.screenshot({ path: path.join(shots, '07-activity.png') });
  });

  it('falls back to WebGL when WebGPU is unavailable', async () => {
    await nav('System').click();
    await page.getByText(/webgl · \d+ FPS/).waitFor({ timeout: 10_000 });
  });
});
