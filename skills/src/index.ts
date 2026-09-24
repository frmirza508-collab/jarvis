import { z } from 'zod';
import { defineSkill, type SkillDefinition } from '@jarvis/skills';
import { JarvisError } from '@jarvis/shared';
import { wrapUntrusted } from '@jarvis/security';

interface FileEntry {
  name: string;
  type: string;
}
interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MARKERS: Record<string, string> = {
  'package.json': 'node',
  'Cargo.toml': 'rust',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'go.mod': 'go',
  'pom.xml': 'java-maven',
  'build.gradle': 'java-gradle',
  'build.gradle.kts': 'java-gradle',
  'CMakeLists.txt': 'cmake',
  'pubspec.yaml': 'flutter',
};

function parseJsonLoose<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = cleaned.search(/[[{]/);
  return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned) as T;
}

// --- coding.inspect_repo ----------------------------------------------------
export const inspectRepo = defineSkill({
  id: 'coding.inspect_repo',
  name: 'Inspect repository',
  description: 'Detect project types, key files and git state of a folder.',
  category: 'coding',
  tools: ['fs.list', 'fs.read', 'git.status'],
  usesModel: false,
  input: z.object({ path: z.string().default('.') }),
  run: async (i, ctx) => {
    const entries = (await ctx.tool('fs.list', { path: i.path })) as FileEntry[];
    const names = entries.map((e) => e.name);
    const kinds = [...new Set(names.filter((n) => MARKERS[n]).map((n) => MARKERS[n]!))];
    let scripts: Record<string, string> = {};
    if (names.includes('package.json')) {
      const pkg = (await ctx.tool('fs.read', { path: `${i.path}/package.json` })) as { content: string };
      scripts = (JSON.parse(pkg.content) as { scripts?: Record<string, string> }).scripts ?? {};
    }
    let git: unknown = null;
    try {
      git = await ctx.tool('git.status', { cwd: i.path });
    } catch {
      git = null;
    }
    return { path: i.path, projectTypes: kinds, topLevel: entries.map((e) => `${e.type === 'directory' ? '[dir] ' : ''}${e.name}`), scripts, git };
  },
});

// --- coding.run_checks ------------------------------------------------------
export function checkCommands(kinds: string[], scripts: Record<string, string>, pm: string): string[] {
  const cmds: string[] = [];
  if (kinds.includes('node')) for (const s of ['typecheck', 'lint', 'test', 'build']) if (scripts[s]) cmds.push(`${pm} run ${s}`);
  if (kinds.includes('rust')) cmds.push('cargo check', 'cargo test');
  if (kinds.includes('python')) cmds.push('python -m pytest -q');
  if (kinds.includes('go')) cmds.push('go vet ./...', 'go test ./...');
  if (kinds.includes('java-maven')) cmds.push('mvn -q test');
  if (kinds.includes('java-gradle')) cmds.push('gradle test');
  if (kinds.includes('flutter')) cmds.push('flutter test');
  return cmds;
}

export const runChecks = defineSkill({
  id: 'coding.run_checks',
  name: 'Run project checks',
  description: 'Detect the project type and run its typecheck, lint, test and build commands; report pass/fail per command.',
  category: 'coding',
  tools: ['fs.list', 'fs.read', 'git.status', 'shell.run'],
  usesModel: false,
  input: z.object({ path: z.string().default('.'), commands: z.array(z.string()).optional() }),
  run: async (i, ctx) => {
    const repo = (await inspectRepo.run({ path: i.path }, ctx)) as { projectTypes: string[]; scripts: Record<string, string>; topLevel: string[] };
    const pm = repo.topLevel.includes('pnpm-lock.yaml') ? 'pnpm' : repo.topLevel.includes('yarn.lock') ? 'yarn' : 'npm';
    const cmds = i.commands ?? checkCommands(repo.projectTypes, repo.scripts, pm);
    if (!cmds.length) throw new JarvisError('NOT_FOUND', 'No known check commands for this project');
    const results: Array<{ command: string; ok: boolean; exitCode: number | null; output: string }> = [];
    for (const command of cmds) {
      ctx.progress(`Running ${command}`);
      const r = (await ctx.tool('shell.run', { command, cwd: i.path, timeoutMs: 900_000 })) as RunResult;
      results.push({ command, ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, output: (r.stdout + '\n' + r.stderr).slice(-6000) });
    }
    return { projectTypes: repo.projectTypes, allPassed: results.every((r) => r.ok), results };
  },
});

// --- research.deep ----------------------------------------------------------
interface Claim {
  claim: string;
  sources: string[];
  kind: 'fact' | 'inference';
}

export const deepResearch = defineSkill({
  id: 'research.deep',
  name: 'Deep web research',
  description: 'Define question, search, gather sources, extract claims, cross-check, and produce a cited answer separating facts from inference.',
  category: 'research',
  tools: ['web.search', 'web.fetch'],
  usesModel: true,
  input: z.object({ question: z.string().min(3), maxSources: z.number().int().min(2).max(12).default(6) }),
  run: async (i, ctx) => {
    ctx.progress('Planning search queries');
    const plan = parseJsonLoose<{ queries: string[] }>(
      await ctx.llm(`Research question: ${i.question}\nReturn JSON {"queries": [2-4 diverse web search queries]}`, { role: 'fast', json: true }),
    );
    const seen = new Set<string>();
    const hits: Array<{ title: string; url: string; snippet: string }> = [];
    for (const q of plan.queries.slice(0, 4)) {
      ctx.progress(`Searching: ${q}`);
      for (const r of (await ctx.tool('web.search', { query: q, count: 6 })) as Array<{ title: string; url: string; snippet: string }>) {
        if (!seen.has(r.url)) {
          seen.add(r.url);
          hits.push(r);
        }
      }
    }
    const sources: Array<{ url: string; title: string; text: string }> = [];
    for (const h of hits) {
      if (sources.length >= i.maxSources) break;
      try {
        ctx.progress(`Reading ${h.url}`);
        const p = (await ctx.tool('web.fetch', { url: h.url, maxChars: 12_000 })) as { url: string; title: string; text: string };
        if (p.text.length > 200) sources.push({ url: p.url, title: p.title || h.title, text: p.text });
      } catch {
        /* unreachable source - skip */
      }
    }
    if (sources.length === 0) throw new JarvisError('NOT_FOUND', 'No readable sources found');
    ctx.progress('Extracting and cross-checking claims');
    const corpus = sources.map((s, n) => wrapUntrusted(`[S${n + 1}] ${s.url}`, s.text.slice(0, 8000))).join('\n\n');
    const extracted = parseJsonLoose<{ claims: Claim[] }>(
      await ctx.llm(
        `Question: ${i.question}\n\nSources:\n${corpus}\n\nExtract the claims relevant to the question. Return JSON {"claims":[{"claim": string, "sources": ["S1",...], "kind": "fact"|"inference"}]}. A claim is "fact" only if stated in a source; list every source that states it.`,
        { role: 'reasoning', json: true },
      ),
    );
    const claims = extracted.claims.map((c) => ({
      ...c,
      status: c.kind === 'inference' ? 'inference' : c.sources.length >= 2 ? 'corroborated' : c.sources.length === 1 ? 'single-source' : 'unsupported',
    }));
    const answer = await ctx.llm(
      `Question: ${i.question}\nClaims (with verification status): ${JSON.stringify(claims)}\nSources: ${sources.map((s, n) => `[S${n + 1}] ${s.title} - ${s.url}`).join('\n')}\n\nWrite a concise answer with inline citations like [S1]. Clearly separate "Verified facts", "Single-source claims" and "Inferences". Do not present unverified claims as facts.`,
      { role: 'reasoning' },
    );
    return { answer, claims, sources: sources.map((s, n) => ({ id: `S${n + 1}`, title: s.title, url: s.url })) };
  },
});

// --- docs.report_pdf --------------------------------------------------------
export const reportPdf = defineSkill({
  id: 'docs.report_pdf',
  name: 'Write report as PDF',
  description: 'Turn content into a structured Markdown report and export it as a PDF; verifies the file exists.',
  category: 'office',
  tools: ['documents.pdf', 'fs.metadata', 'fs.write'],
  usesModel: true,
  input: z.object({ title: z.string(), brief: z.string().min(10), path: z.string(), language: z.string().default('en') }),
  run: async (i, ctx) => {
    ctx.progress('Drafting report');
    const markdown = await ctx.llm(
      `Write a well-structured report in Markdown (language: ${i.language}) titled "${i.title}". Use headings, tables where useful and a short executive summary. Material:\n${i.brief}`,
      { role: 'reasoning' },
    );
    const { path } = (await ctx.tool('documents.pdf', { path: i.path, title: i.title, markdown, rtl: i.language === 'ur' })) as { path: string };
    const meta = (await ctx.tool('fs.metadata', { path })) as { size: number };
    if (!meta.size) throw new JarvisError('INTERNAL', 'PDF was not written');
    return { path, bytes: meta.size, markdown };
  },
});

// --- marketing.seo_audit ----------------------------------------------------
export const seoAudit = defineSkill({
  id: 'marketing.seo_audit',
  name: 'SEO audit',
  description: 'Fetch pages, extract SEO metadata deterministically and produce prioritised recommendations.',
  category: 'marketing',
  tools: ['web.page_meta'],
  usesModel: true,
  input: z.object({ urls: z.array(z.string()).min(1).max(25) }),
  run: async (i, ctx) => {
    const pages: unknown[] = [];
    for (const url of i.urls) {
      ctx.progress(`Auditing ${url}`);
      try {
        pages.push(await ctx.tool('web.page_meta', { url }));
      } catch (e) {
        pages.push({ url, error: (e as Error).message });
      }
    }
    const findings = await ctx.llm(
      `SEO metadata for pages (measured, not guessed): ${JSON.stringify(pages).slice(0, 60_000)}\nProduce a prioritised SEO findings list per page (title length, meta description, H1 usage, alt coverage, canonical, Open Graph, response time) and a comparison table in Markdown.`,
      { role: 'reasoning' },
    );
    return { pages, findings };
  },
});

export const SKILL_CATALOG: SkillDefinition[] = [inspectRepo, runChecks, deepResearch, reportPdf, seoAudit] as SkillDefinition[];
