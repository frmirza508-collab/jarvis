import { z } from 'zod';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { marked } from 'marked';
import { isProtectedPath } from '@jarvis/security';
import { defineTool, type ToolDefinition } from '@jarvis/tool-runtime';
import type { BrowserSession } from './index.js';

const STYLE = `
body { font-family: 'Segoe UI', 'Noto Sans', 'Noto Nastaliq Urdu', 'Microsoft YaHei', sans-serif; margin: 40px; color: #111; line-height: 1.5; }
h1, h2, h3 { color: #0b3d91; } table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { border: 1px solid #bbb; padding: 6px 8px; text-align: left; vertical-align: top; } th { background: #eef3fb; }
code, pre { background: #f4f4f4; font-family: Consolas, monospace; } pre { padding: 10px; overflow-x: auto; }
[dir=rtl] { text-align: right; }`;

export function markdownToHtml(markdown: string, title: string, rtl = false): string {
  const body = marked.parse(markdown, { async: false }) as string;
  const esc = title.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  return `<!doctype html><html${rtl ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><title>${esc}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

/**
 * Renders Markdown to a real PDF with headless Chromium/Edge (page.pdf).
 * Uses its own headless browser so it never disturbs the visible automation browser.
 */
export function documentTools(session: BrowserSession): ToolDefinition[] {
  return [
    defineTool({
      id: 'documents.pdf',
      title: 'Create PDF',
      description: 'Create a PDF document from Markdown content (tables, headings, lists supported).',
      module: 'documents',
      categories: ['WRITE'],
      input: z.object({ path: z.string().min(1), title: z.string().default('JARVIS Report'), markdown: z.string().min(1), rtl: z.boolean().optional() }),
      status: () => (session.isAvailable().ok ? 'active' : 'not_configured'),
      statusReason: () => session.isAvailable().reason,
      assess: (i, ctx) => {
        const p = path.resolve(ctx.workspace ?? process.cwd(), i.path);
        return { risk: 'medium', target: p, description: `Create PDF ${p}`, blocked: isProtectedPath(p), reasons: ['protected system path'] };
      },
      execute: async (i, ctx) => {
        const p = path.resolve(ctx.workspace ?? process.cwd(), i.path.endsWith('.pdf') ? i.path : `${i.path}.pdf`);
        mkdirSync(path.dirname(p), { recursive: true });
        const { chromium } = await import('playwright-core');
        const browser = await chromium.launch({ headless: true, executablePath: session.opts.executablePath, channel: session.opts.executablePath ? undefined : session.opts.channel });
        try {
          const page = await browser.newPage();
          await page.setContent(markdownToHtml(i.markdown, i.title, i.rtl), { waitUntil: 'load' });
          await page.pdf({ path: p, format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
        } finally {
          await browser.close();
        }
        return { path: p };
      },
    }),
  ] as ToolDefinition[];
}
