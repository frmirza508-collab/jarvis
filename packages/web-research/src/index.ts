import { z } from 'zod';
import { JarvisError } from '@jarvis/shared';
import { defineTool, type ToolDefinition } from '@jarvis/tool-runtime';
import { scanForInjection, wrapUntrusted } from '@jarvis/security';
import { assertSafeUrl } from '@jarvis/browser-control';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchProvider {
  readonly id: string;
  isConfigured(): boolean;
  search(query: string, opts?: { count?: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

/** Brave Search API (https://api.search.brave.com). Requires BRAVE_SEARCH_API_KEY. */
export class BraveSearchProvider implements SearchProvider {
  readonly id = 'brave';
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly f: typeof fetch = fetch,
  ) {}
  isConfigured() {
    return !!this.apiKey();
  }
  async search(query: string, opts: { count?: number; signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const key = this.apiKey();
    if (!key) throw new JarvisError('NOT_CONFIGURED', 'Brave Search API key not configured');
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(Math.min(20, opts.count ?? 8)));
    const res = await this.f(u, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: opts.signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new JarvisError('PROVIDER_ERROR', `Brave search failed: ${res.status}`);
    const j = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description?: string }> };
    };
    return (j.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: stripTags(r.description ?? ''),
      source: 'brave',
    }));
  }
}

/** Tavily search API. Requires TAVILY_API_KEY. */
export class TavilySearchProvider implements SearchProvider {
  readonly id = 'tavily';
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly f: typeof fetch = fetch,
  ) {}
  isConfigured() {
    return !!this.apiKey();
  }
  async search(query: string, opts: { count?: number; signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const key = this.apiKey();
    if (!key) throw new JarvisError('NOT_CONFIGURED', 'Tavily API key not configured');
    const res = await this.f('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ api_key: key, query, max_results: Math.min(20, opts.count ?? 8) }),
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new JarvisError('PROVIDER_ERROR', `Tavily search failed: ${res.status}`);
    const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
    return (j.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? '',
      source: 'tavily',
    }));
  }
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export interface FetchedPage {
  url: string;
  status: number;
  title: string;
  text: string;
  injection: { suspicious: boolean; findings: string[] };
  forModel: string;
}

export async function fetchPage(
  url: string,
  f: typeof fetch = fetch,
  maxChars = 50_000,
): Promise<FetchedPage> {
  const safe = assertSafeUrl(url);
  const res = await f(safe, {
    headers: {
      'User-Agent': 'JARVIS-Research/0.1 (+desktop assistant)',
      Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!/text|html|json|xml/.test(ct))
    throw new JarvisError('INVALID_INPUT', `Unsupported content type ${ct}`);
  const raw = (await res.text()).slice(0, 2_000_000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? '';
  const text = (/html/.test(ct) ? stripTags(raw) : raw).slice(0, maxChars);
  return {
    url: res.url || safe,
    status: res.status,
    title: stripTags(title),
    text,
    injection: scanForInjection(text),
    forModel: wrapUntrusted(res.url || safe, text),
  };
}

export class SearchRouter {
  constructor(private readonly providers: SearchProvider[]) {}
  available(): SearchProvider[] {
    return this.providers.filter((p) => p.isConfigured());
  }
  async search(query: string, count = 8): Promise<SearchResult[]> {
    const ps = this.available();
    if (!ps.length)
      throw new JarvisError(
        'NOT_CONFIGURED',
        'No web search provider configured (set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY).',
      );
    let last: unknown;
    for (const p of ps) {
      try {
        return await p.search(query, { count });
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new JarvisError('PROVIDER_ERROR', 'search failed');
  }
}

export function researchTools(router: SearchRouter, f: typeof fetch = fetch): ToolDefinition[] {
  return [
    defineTool({
      id: 'web.search',
      title: 'Web search',
      description: 'Search the web and return titles, URLs and snippets.',
      module: 'web-research',
      categories: ['NETWORK'],
      input: z.object({ query: z.string().min(2), count: z.number().int().min(1).max(20).optional() }),
      status: () => (router.available().length ? 'active' : 'not_configured'),
      statusReason: () =>
        router.available().length ? undefined : 'Configure BRAVE_SEARCH_API_KEY or TAVILY_API_KEY',
      execute: (i) => router.search(i.query, i.count),
    }),
    defineTool({
      id: 'web.fetch',
      title: 'Fetch page',
      description: 'Fetch a web page over HTTP and return its readable text (untrusted content).',
      module: 'web-research',
      categories: ['NETWORK'],
      input: z.object({
        url: z.string().min(4),
        maxChars: z.number().int().positive().max(200_000).optional(),
      }),
      assess: (i) => ({ risk: 'low', target: assertSafeUrl(i.url) }),
      execute: (i) => fetchPage(i.url, f, i.maxChars),
    }),
  ] as ToolDefinition[];
}

export interface PageMeta {
  url: string;
  status: number;
  title: string;
  metaDescription: string;
  canonical?: string;
  lang?: string;
  robots?: string;
  h1: string[];
  h2: string[];
  wordCount: number;
  images: number;
  imagesMissingAlt: number;
  internalLinks: number;
  externalLinks: number;
  openGraph: Record<string, string>;
  responseTimeMs: number;
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
}

/** Deterministic SEO-relevant metadata extraction from raw HTML. */
export function extractPageMeta(html: string, url: string, status: number, responseTimeMs: number): PageMeta {
  const host = new URL(url).host;
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  const metaBy = (key: string, val: string) => metas.find((m) => attr(m, key)?.toLowerCase() === val);
  const og: Record<string, string> = {};
  for (const m of metas) {
    const p = attr(m, 'property');
    if (p?.startsWith('og:')) og[p] = attr(m, 'content') ?? '';
  }
  const heads = (lvl: number) =>
    [...html.matchAll(new RegExp(`<h${lvl}\\b[^>]*>([\\s\\S]*?)</h${lvl}>`, 'gi'))]
      .map((m) => stripTags(m[1] ?? ''))
      .filter(Boolean);
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  let internal = 0;
  let external = 0;
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1]!, url);
      if (u.protocol.startsWith('http')) {
        if (u.host === host) internal++;
        else external++;
      }
    } catch {
      /* ignore */
    }
  }
  const canonicalTag = (html.match(/<link\b[^>]*>/gi) ?? []).find(
    (l) => attr(l, 'rel')?.toLowerCase() === 'canonical',
  );
  return {
    url,
    status,
    title: stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
    metaDescription: attr(metaBy('name', 'description') ?? '', 'content') ?? '',
    canonical: canonicalTag ? attr(canonicalTag, 'href') : undefined,
    lang: /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1],
    robots: attr(metaBy('name', 'robots') ?? '', 'content'),
    h1: heads(1),
    h2: heads(2).slice(0, 30),
    wordCount: stripTags(html).split(/\s+/).filter(Boolean).length,
    images: imgs.length,
    imagesMissingAlt: imgs.filter((i) => !/\balt\s*=\s*["'][^"']+["']/i.test(i)).length,
    internalLinks: internal,
    externalLinks: external,
    openGraph: og,
    responseTimeMs,
  };
}

export function pageMetaTool(f: typeof fetch = fetch): ToolDefinition {
  return defineTool({
    id: 'web.page_meta',
    title: 'Page SEO metadata',
    description:
      'Fetch a URL and extract SEO metadata: title, meta description, headings, links, image alt coverage, Open Graph.',
    module: 'web-research',
    categories: ['NETWORK'],
    input: z.object({ url: z.string().min(4) }),
    assess: (i) => ({ risk: 'low', target: assertSafeUrl(i.url) }),
    execute: async (i) => {
      const safe = assertSafeUrl(i.url);
      const t0 = Date.now();
      const res = await f(safe, {
        headers: { 'User-Agent': 'JARVIS-SEO/0.1' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      const html = (await res.text()).slice(0, 3_000_000);
      return extractPageMeta(html, res.url || safe, res.status, Date.now() - t0);
    },
  }) as ToolDefinition;
}
