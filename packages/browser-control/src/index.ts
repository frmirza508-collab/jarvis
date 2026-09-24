import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { JarvisError } from '@jarvis/shared';
import { defineTool, type ToolDefinition } from '@jarvis/tool-runtime';
import { scanForInjection, wrapUntrusted } from '@jarvis/security';

export interface BrowserOptions {
  /** Explicit browser executable. On Windows, Microsoft Edge is used by default. */
  executablePath?: string;
  channel?: 'msedge' | 'chrome';
  headless?: boolean;
  /** Dedicated automation profile - never the user's everyday profile. */
  profileDir?: string;
  downloadsDir?: string;
}

function defaultOptions(): BrowserOptions {
  const exe = process.env.JARVIS_BROWSER_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
  return {
    executablePath: exe && existsSync(exe) ? exe : undefined,
    channel: exe ? undefined : process.platform === 'win32' ? 'msedge' : undefined,
    headless: process.env.JARVIS_BROWSER_HEADLESS === '1',
    downloadsDir: path.join(os.homedir(), 'Downloads', 'JARVIS'),
  };
}

export function assertSafeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new JarvisError('INVALID_INPUT', `Invalid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new JarvisError('PERMISSION_DENIED', `Blocked URL scheme ${u.protocol}`);
  return u.toString();
}

/** Owns one automation browser context with a dedicated profile. */
export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  readonly opts: BrowserOptions;

  constructor(opts: BrowserOptions = {}) {
    this.opts = { ...defaultOptions(), ...opts };
  }

  isAvailable(): { ok: boolean; reason?: string } {
    if (this.opts.executablePath || this.opts.channel) return { ok: true };
    return { ok: false, reason: 'No browser configured. Set JARVIS_BROWSER_PATH to a Chromium/Edge/Chrome executable.' };
  }

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const { chromium } = await import('playwright-core');
    const launch = {
      headless: this.opts.headless ?? false,
      executablePath: this.opts.executablePath,
      channel: this.opts.executablePath ? undefined : this.opts.channel,
      acceptDownloads: true,
    };
    if (this.opts.profileDir) {
      mkdirSync(this.opts.profileDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.opts.profileDir, launch);
    } else {
      this.browser = await chromium.launch(launch);
      this.context = await this.browser.newContext({ acceptDownloads: true });
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  injection: { suspicious: boolean; findings: string[] };
  /** Page content wrapped in the untrusted-content envelope for model consumption. */
  forModel: string;
}

export async function snapshot(page: Page, maxChars = 40_000): Promise<PageSnapshot> {
  // Runs inside the page; written as a string so this Node package needs no DOM typings.
  const data = (await page.evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 200)
      .map((a) => ({ text: (a.textContent || '').trim().slice(0, 120), href: a.href }));
    return { title: document.title, text: document.body ? document.body.innerText : '', links };
  })()`)) as { title: string; text: string; links: Array<{ text: string; href: string }> };
  const text = data.text.slice(0, maxChars);
  return {
    url: page.url(),
    title: data.title,
    text,
    links: data.links,
    injection: scanForInjection(text),
    forModel: wrapUntrusted(page.url(), `TITLE: ${data.title}\n\n${text}`),
  };
}

function locator(page: Page, target: { selector?: string; text?: string; label?: string }) {
  if (target.selector) return page.locator(target.selector).first();
  if (target.label) return page.getByLabel(target.label).first();
  if (target.text) return page.getByText(target.text, { exact: false }).first();
  throw new JarvisError('INVALID_INPUT', 'Provide selector, label or text');
}

const Target = z.object({ selector: z.string().optional(), text: z.string().optional(), label: z.string().optional() });

export function browserTools(session: BrowserSession): ToolDefinition[] {
  const status = () => (session.isAvailable().ok ? 'active' : 'not_configured') as 'active' | 'not_configured';
  const statusReason = () => session.isAvailable().reason;
  const base = { module: 'browser-control', status, statusReason };
  return [
    defineTool({
      ...base,
      id: 'browser.open',
      title: 'Open web page',
      description: 'Navigate the automation browser to a URL and return the page snapshot (untrusted content).',
      categories: ['BROWSER', 'NETWORK'],
      input: z.object({ url: z.string().min(1) }),
      assess: (i) => ({ risk: 'medium', target: assertSafeUrl(i.url) }),
      execute: async (i) => {
        const page = await session.getPage();
        await page.goto(assertSafeUrl(i.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
        return snapshot(page);
      },
    }),
    defineTool({
      ...base,
      id: 'browser.extract',
      title: 'Extract page',
      description: 'Return the current page title, text and links (untrusted content).',
      categories: ['BROWSER'],
      input: z.object({ maxChars: z.number().int().positive().max(200_000).optional() }),
      execute: async (i) => snapshot(await session.getPage(), i.maxChars),
    }),
    defineTool({
      ...base,
      id: 'browser.click',
      title: 'Click element',
      description: 'Click an element by CSS selector, accessible label, or visible text.',
      categories: ['BROWSER'],
      input: Target,
      assess: (i) => ({ risk: 'medium', description: `Click ${i.selector ?? i.label ?? i.text}` }),
      execute: async (i) => {
        const page = await session.getPage();
        await locator(page, i).click({ timeout: 15_000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return { url: page.url(), title: await page.title() };
      },
    }),
    defineTool({
      ...base,
      id: 'browser.type',
      title: 'Type text',
      description: 'Type text into an input identified by selector, label or text.',
      categories: ['BROWSER'],
      input: Target.extend({ value: z.string(), submit: z.boolean().optional() }),
      assess: (i) => ({ risk: 'medium', description: `Type into ${i.selector ?? i.label ?? i.text}` }),
      execute: async (i) => {
        const page = await session.getPage();
        const loc = locator(page, i);
        await loc.fill(i.value, { timeout: 15_000 });
        if (i.submit) await loc.press('Enter');
        return { ok: true };
      },
    }),
    defineTool({
      ...base,
      id: 'browser.fill_form',
      title: 'Fill form',
      description: 'Fill several form fields by label or selector. Does not submit unless submitSelector is given.',
      categories: ['BROWSER', 'WRITE'],
      input: z.object({
        fields: z.array(Target.extend({ value: z.string() })).min(1).max(50),
        submitSelector: z.string().optional(),
      }),
      assess: (i) => ({ risk: i.submitSelector ? 'high' : 'medium', description: `Fill ${i.fields.length} form fields${i.submitSelector ? ' and submit' : ''}` }),
      execute: async (i) => {
        const page = await session.getPage();
        for (const f of i.fields) await locator(page, f).fill(f.value, { timeout: 15_000 });
        if (i.submitSelector) await page.locator(i.submitSelector).first().click();
        return { filled: i.fields.length, submitted: !!i.submitSelector, url: page.url() };
      },
    }),
    defineTool({
      ...base,
      id: 'browser.screenshot',
      title: 'Page screenshot',
      description: 'Save a PNG screenshot of the current page.',
      categories: ['BROWSER', 'WRITE'],
      input: z.object({ path: z.string(), fullPage: z.boolean().optional() }),
      assess: (i) => ({ risk: 'medium', target: path.resolve(i.path) }),
      execute: async (i) => {
        const page = await session.getPage();
        const p = path.resolve(i.path);
        mkdirSync(path.dirname(p), { recursive: true });
        await page.screenshot({ path: p, fullPage: i.fullPage ?? false });
        return { path: p };
      },
    }),
    defineTool({
      ...base,
      id: 'browser.download',
      title: 'Download file',
      description: 'Click a link/button that triggers a download and save the file to the JARVIS downloads folder.',
      categories: ['BROWSER', 'WRITE', 'NETWORK'],
      input: Target,
      assess: () => ({ risk: 'high', description: 'Download a file from the web' }),
      execute: async (i) => {
        const page = await session.getPage();
        const dir = session.opts.downloadsDir ?? path.join(os.homedir(), 'Downloads', 'JARVIS');
        mkdirSync(dir, { recursive: true });
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), locator(page, i).click()]);
        const dest = path.join(dir, path.basename(dl.suggestedFilename()));
        await dl.saveAs(dest);
        return { path: dest, url: dl.url() };
      },
    }),
    defineTool({
      ...base,
      id: 'browser.upload',
      title: 'Upload file',
      description: 'Attach a local file to a file input. Always requires confirmation.',
      categories: ['BROWSER', 'SENSITIVE'],
      input: z.object({ selector: z.string(), filePath: z.string() }),
      assess: (i) => ({ risk: 'high', target: path.resolve(i.filePath), description: `Upload ${path.resolve(i.filePath)} to the current web page` }),
      execute: async (i) => {
        const page = await session.getPage();
        await page.locator(i.selector).first().setInputFiles(path.resolve(i.filePath));
        return { uploaded: path.resolve(i.filePath), url: page.url() };
      },
    }),
    defineTool({
      ...base,
      id: 'browser.close',
      title: 'Close browser',
      description: 'Close the automation browser.',
      categories: ['BROWSER'],
      input: z.object({}),
      execute: async () => {
        await session.close();
        return { closed: true };
      },
    }),
  ] as ToolDefinition[];
}
