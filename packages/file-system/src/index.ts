import { z } from 'zod';
import fs from 'node:fs/promises';
import { createReadStream, type Dirent } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JarvisError } from '@jarvis/shared';
import { defineTool, type ToolDefinition } from '@jarvis/tool-runtime';
import { isProtectedPath, isSensitivePath } from '@jarvis/security';

const MAX_READ_BYTES = 2 * 1024 * 1024;

function guardWrite(p: string): void {
  if (isProtectedPath(p))
    throw new JarvisError('PERMISSION_DENIED', `Refusing to modify protected system path: ${p}`);
}

function resolveUserPath(p: string, workspace?: string): string {
  if (p.startsWith('~')) p = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', p.slice(1));
  return path.resolve(workspace ?? process.cwd(), p);
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}

async function entry(p: string): Promise<FileEntry> {
  const st = await fs.lstat(p);
  return {
    name: path.basename(p),
    path: p,
    type: st.isFile() ? 'file' : st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'other',
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
  };
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  '$RECYCLE.BIN',
  'System Volume Information',
  'AppData',
]);

/** Walks a directory tree breadth-first, bounded by maxEntries. */
export async function walk(
  root: string,
  opts: { maxEntries?: number; maxDepth?: number } = {},
): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const max = opts.maxEntries ?? 5000;
  const maxDepth = opts.maxDepth ?? 8;
  const queue: Array<[string, number]> = [[root, 0]];
  while (queue.length && out.length < max) {
    const [dir, depth] = queue.shift()!;
    let items: Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (out.length >= max) break;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (IGNORED_DIRS.has(it.name) || it.name.startsWith('.')) continue;
        if (depth + 1 <= maxDepth) queue.push([full, depth + 1]);
      }
      try {
        out.push(await entry(full));
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

/** Incremental file index for "indexed file awareness" within project workspaces. */
export class FileIndex {
  private entries = new Map<string, FileEntry>();
  private roots = new Set<string>();

  async addRoot(root: string): Promise<number> {
    const abs = path.resolve(root);
    this.roots.add(abs);
    for (const e of await walk(abs)) this.entries.set(e.path, e);
    return this.entries.size;
  }

  async refresh(): Promise<number> {
    this.entries.clear();
    for (const r of this.roots) for (const e of await walk(r)) this.entries.set(e.path, e);
    return this.entries.size;
  }

  listRoots(): string[] {
    return [...this.roots];
  }

  search(query: string, limit = 50): FileEntry[] {
    const q = query.toLowerCase();
    const scored: Array<[number, FileEntry]> = [];
    for (const e of this.entries.values()) {
      const name = e.name.toLowerCase();
      const score =
        name === q
          ? 3
          : name.startsWith(q)
            ? 2
            : name.includes(q)
              ? 1
              : e.path.toLowerCase().includes(q)
                ? 0.5
                : 0;
      if (score > 0) scored.push([score, e]);
    }
    return scored
      .sort((a, b) => b[0] - a[0])
      .slice(0, limit)
      .map(([, e]) => e);
  }

  size(): number {
    return this.entries.size;
  }
}

async function sha256(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export function fileSystemTools(index: FileIndex): ToolDefinition[] {
  const P = z.object({ path: z.string().min(1) });
  return [
    defineTool({
      id: 'fs.read',
      title: 'Read file',
      description: 'Read a UTF-8 text file (max 2 MB).',
      module: 'file-system',
      categories: ['READ'],
      input: P.extend({ maxBytes: z.number().int().positive().max(MAX_READ_BYTES).optional() }),
      assess: (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        return isSensitivePath(p)
          ? { risk: 'high', target: p, description: `Read sensitive file ${p}` }
          : { risk: 'low', target: p };
      },
      execute: async (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        const st = await fs.stat(p);
        const limit = i.maxBytes ?? MAX_READ_BYTES;
        const fh = await fs.open(p, 'r');
        try {
          const buf = Buffer.alloc(Math.min(st.size, limit));
          await fh.read(buf, 0, buf.length, 0);
          return { path: p, size: st.size, truncated: st.size > limit, content: buf.toString('utf8') };
        } finally {
          await fh.close();
        }
      },
    }),
    defineTool({
      id: 'fs.list',
      title: 'List directory',
      description: 'List entries in a directory.',
      module: 'file-system',
      categories: ['READ'],
      input: P,
      assess: (i, ctx) => ({ risk: 'low', target: resolveUserPath(i.path, ctx.workspace) }),
      execute: async (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        const names = await fs.readdir(p);
        const out: FileEntry[] = [];
        for (const n of names.slice(0, 1000)) {
          try {
            out.push(await entry(path.join(p, n)));
          } catch {
            /* skip */
          }
        }
        return out;
      },
    }),
    defineTool({
      id: 'fs.metadata',
      title: 'File metadata',
      description: 'Get size, type, timestamps and SHA-256 of a file.',
      module: 'file-system',
      categories: ['READ'],
      input: P.extend({ hash: z.boolean().optional() }),
      assess: (i, ctx) => ({ risk: 'low', target: resolveUserPath(i.path, ctx.workspace) }),
      execute: async (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        const st = await fs.stat(p);
        return {
          path: p,
          size: st.size,
          isDirectory: st.isDirectory(),
          createdAt: st.birthtime.toISOString(),
          modifiedAt: st.mtime.toISOString(),
          sha256: i.hash && st.isFile() ? await sha256(p) : undefined,
        };
      },
    }),
    defineTool({
      id: 'fs.search',
      title: 'Search files',
      description:
        'Search indexed workspaces by file name; optionally add a new workspace root to the index first.',
      module: 'file-system',
      categories: ['READ'],
      input: z.object({
        query: z.string().min(1),
        addRoot: z.string().optional(),
        limit: z.number().int().max(500).optional(),
      }),
      execute: async (i, ctx) => {
        if (i.addRoot) await index.addRoot(resolveUserPath(i.addRoot, ctx.workspace));
        return { indexed: index.size(), roots: index.listRoots(), results: index.search(i.query, i.limit) };
      },
    }),
    defineTool({
      id: 'fs.write',
      title: 'Write file',
      description: 'Create or overwrite a text file. Parent directories are created.',
      module: 'file-system',
      categories: ['WRITE'],
      input: P.extend({ content: z.string(), overwrite: z.boolean().default(false) }),
      assess: (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        return {
          risk: i.overwrite ? 'high' : 'medium',
          target: p,
          description: `${i.overwrite ? 'Overwrite' : 'Create'} file ${p}`,
          blocked: isProtectedPath(p),
          reasons: ['protected system path'],
        };
      },
      execute: async (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        guardWrite(p);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, i.content, { flag: i.overwrite ? 'w' : 'wx' });
        return { path: p, bytes: Buffer.byteLength(i.content) };
      },
    }),
    defineTool({
      id: 'fs.edit',
      title: 'Edit file',
      description: 'Replace an exact, unique text fragment in a file.',
      module: 'file-system',
      categories: ['WRITE'],
      input: P.extend({ find: z.string().min(1), replace: z.string() }),
      assess: (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        return {
          risk: 'medium',
          target: p,
          description: `Edit file ${p}`,
          blocked: isProtectedPath(p),
          reasons: ['protected system path'],
        };
      },
      execute: async (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        guardWrite(p);
        const text = await fs.readFile(p, 'utf8');
        const first = text.indexOf(i.find);
        if (first < 0) throw new JarvisError('INVALID_INPUT', 'Text to replace was not found');
        if (text.indexOf(i.find, first + 1) >= 0)
          throw new JarvisError('INVALID_INPUT', 'Text to replace is not unique');
        await fs.writeFile(p, text.slice(0, first) + i.replace + text.slice(first + i.find.length));
        return { path: p, replaced: 1 };
      },
    }),
    defineTool({
      id: 'fs.mkdir',
      title: 'Create folder',
      description: 'Create a directory (recursively).',
      module: 'file-system',
      categories: ['WRITE'],
      input: P,
      assess: (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        return { risk: 'low', target: p, blocked: isProtectedPath(p), reasons: ['protected system path'] };
      },
      execute: async (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        guardWrite(p);
        await fs.mkdir(p, { recursive: true });
        return { path: p };
      },
    }),
    defineTool({
      id: 'fs.copy',
      title: 'Copy',
      description: 'Copy a file or directory.',
      module: 'file-system',
      categories: ['WRITE'],
      input: z.object({ from: z.string(), to: z.string(), overwrite: z.boolean().default(false) }),
      assess: (i, ctx) => {
        const to = resolveUserPath(i.to, ctx.workspace);
        return {
          risk: i.overwrite ? 'high' : 'medium',
          target: to,
          description: `Copy ${i.from} -> ${to}`,
          blocked: isProtectedPath(to),
          reasons: ['protected system path'],
        };
      },
      execute: async (i, ctx) => {
        const from = resolveUserPath(i.from, ctx.workspace);
        const to = resolveUserPath(i.to, ctx.workspace);
        guardWrite(to);
        await fs.cp(from, to, { recursive: true, force: i.overwrite, errorOnExist: !i.overwrite });
        return { from, to };
      },
    }),
    defineTool({
      id: 'fs.move',
      title: 'Move / rename',
      description: 'Move or rename a file or directory.',
      module: 'file-system',
      categories: ['WRITE'],
      input: z.object({ from: z.string(), to: z.string() }),
      assess: (i, ctx) => {
        const from = resolveUserPath(i.from, ctx.workspace);
        const to = resolveUserPath(i.to, ctx.workspace);
        return {
          risk: 'medium',
          target: from,
          description: `Move ${from} -> ${to}`,
          blocked: isProtectedPath(from) || isProtectedPath(to),
          reasons: ['protected system path'],
        };
      },
      execute: async (i, ctx) => {
        const from = resolveUserPath(i.from, ctx.workspace);
        const to = resolveUserPath(i.to, ctx.workspace);
        guardWrite(from);
        guardWrite(to);
        try {
          await fs.access(to);
          throw new JarvisError('INVALID_INPUT', `Destination exists: ${to}`);
        } catch (e) {
          if (e instanceof JarvisError) throw e;
        }
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        return { from, to };
      },
    }),
    defineTool({
      id: 'fs.delete',
      title: 'Delete',
      description: 'Delete a file or directory. Always requires confirmation.',
      module: 'file-system',
      categories: ['DESTRUCTIVE'],
      input: P.extend({ recursive: z.boolean().default(false) }),
      assess: (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        return {
          risk: 'critical',
          target: p,
          description: `Permanently delete ${p}${i.recursive ? ' and everything inside it' : ''}`,
          blocked: isProtectedPath(p),
          reasons: ['protected system path'],
        };
      },
      execute: async (i, ctx) => {
        const p = resolveUserPath(i.path, ctx.workspace);
        guardWrite(p);
        await fs.rm(p, { recursive: i.recursive, force: false });
        return { deleted: p };
      },
    }),
  ] as ToolDefinition[];
}
