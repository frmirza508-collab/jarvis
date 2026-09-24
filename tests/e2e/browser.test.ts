import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { BrowserSession, browserTools, documentTools } from '@jarvis/browser-control';
import { pageMetaTool, researchTools, SearchRouter } from '@jarvis/web-research';
import { makeRuntime } from '../helpers/runtime.js';
import { findChromium } from '../helpers/browser.js';
import { startSite } from '../helpers/site.js';

const chromium = findChromium();
const d = chromium ? describe : describe.skip;

d('browser automation (real Chromium)', () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  const dl = mkdtempSync(path.join(os.tmpdir(), 'jarvis-dl-'));
  const session = new BrowserSession({ executablePath: chromium, headless: true, downloadsDir: dl });
  const rt = makeRuntime(async () => 'allow_once');
  for (const t of [
    ...browserTools(session),
    ...documentTools(session),
    ...researchTools(new SearchRouter([])),
    pageMetaTool(),
  ])
    rt.tools.register(t);
  const ctx = { actor: 'browser-automation', workspace: dl };

  beforeAll(async () => {
    site = await startSite();
  });
  afterAll(async () => {
    await session.close();
    await site.close();
  });

  it('navigates and extracts page content as untrusted data', async () => {
    const snap = (await rt.tools.invoke('browser.open', { url: site.url }, ctx)) as {
      title: string;
      text: string;
      forModel: string;
      links: unknown[];
    };
    expect(snap.title).toBe('Acme Home');
    expect(snap.text).toContain('Starter plan costs 100 dollars');
    expect(snap.forModel).toContain('<untrusted_content');
    expect(snap.links.length).toBeGreaterThanOrEqual(3);
  });

  it('runs a multi-step workflow: click, fill form, submit', async () => {
    await rt.tools.invoke('browser.open', { url: site.url }, ctx);
    await rt.tools.invoke('browser.click', { text: 'Contact form' }, ctx);
    const r = (await rt.tools.invoke(
      'browser.fill_form',
      {
        fields: [
          { label: 'Name', value: 'Fazal' },
          { label: 'Email', value: 'f@example.com' },
        ],
        submitSelector: '#send',
      },
      ctx,
    )) as { submitted: boolean };
    expect(r.submitted).toBe(true);
    await expect.poll(() => site.submissions.length).toBe(1);
    expect(site.submissions[0]).toEqual({ name: 'Fazal', email: 'f@example.com' });
  });

  it('downloads files and takes screenshots', async () => {
    await rt.tools.invoke('browser.open', { url: site.url }, ctx);
    const d1 = (await rt.tools.invoke('browser.download', { text: 'Download price list' }, ctx)) as {
      path: string;
    };
    expect(readFileSync(d1.path, 'utf8')).toContain('starter,100');
    const shot = (await rt.tools.invoke('browser.screenshot', { path: path.join(dl, 'shot.png') }, ctx)) as {
      path: string;
    };
    expect(readFileSync(shot.path).subarray(1, 4).toString()).toBe('PNG');
  });

  it('flags prompt injection on hostile pages', async () => {
    const snap = (await rt.tools.invoke('browser.open', { url: `${site.url}/evil` }, ctx)) as {
      injection: { suspicious: boolean };
      forModel: string;
    };
    expect(snap.injection.suspicious).toBe(true);
    expect(snap.forModel).toContain('WARNING');
  });

  it('blocks non-http schemes', async () => {
    await expect(rt.tools.invoke('browser.open', { url: 'file:///etc/passwd' }, ctx)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('creates a real PDF from Markdown', async () => {
    const r = (await rt.tools.invoke(
      'documents.pdf',
      {
        path: 'report.pdf',
        title: 'Test',
        markdown: '# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nاردو متن 中文',
      },
      ctx,
    )) as { path: string };
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('extracts SEO metadata deterministically', async () => {
    const m = (await rt.tools.invoke('web.page_meta', { url: site.url }, ctx)) as Record<string, unknown>;
    expect(m).toMatchObject({
      title: 'Acme Home',
      metaDescription: 'Acme builds rockets.',
      h1: ['Acme Rockets'],
      images: 2,
      imagesMissingAlt: 1,
      externalLinks: 1,
      lang: 'en',
    });
  });

  it('fetches pages over HTTP with untrusted wrapping', async () => {
    const p = (await rt.tools.invoke('web.fetch', { url: `${site.url}/evil` }, ctx)) as {
      injection: { suspicious: boolean };
    };
    expect(p.injection.suspicious).toBe(true);
  });

  it('reports web search as not configured without a provider key', () => {
    expect(rt.tools.statusOf('web.search').state).toBe('not_configured');
  });
});
