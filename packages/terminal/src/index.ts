import { z } from 'zod';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { JarvisError } from '@jarvis/shared';
import { defineTool, type ToolDefinition } from '@jarvis/tool-runtime';
import { assessCommand, redactString } from '@jarvis/security';

export interface RunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 200_000;

function shellFor(platform = process.platform): { file: string; args: (cmd: string) => string[] } {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: (cmd) => [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        cmd,
      ],
    };
  }
  return { file: '/bin/bash', args: (cmd) => ['-lc', cmd] };
}

/** Runs a command with timeout, output caps, cancellation and a scrubbed environment. */
export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> },
): Promise<RunResult> {
  const sh = shellFor();
  const started = Date.now();
  // Never leak JARVIS's own secrets into child processes.
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  for (const k of Object.keys(env))
    if (/^(JARVIS_|OPENROUTER_|LICENSE_|STRIPE_|DATABASE_URL)/.test(k)) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(sh.file, sh.args(command), { cwd: opts.cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, d: Buffer) => (s.length < MAX_OUTPUT ? s + d.toString('utf8') : s);
    child.stdout.on('data', (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on('data', (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 120_000);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new JarvisError('INTERNAL', `Failed to start shell: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new JarvisError('CANCELLED', 'Command cancelled'));
      resolve({
        command,
        cwd: opts.cwd,
        exitCode: code,
        stdout: redactString(stdout.slice(0, MAX_OUTPUT)),
        stderr: redactString(stderr.slice(0, MAX_OUTPUT)),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

function cwdOf(input: { cwd?: string }, workspace?: string): string {
  return path.resolve(workspace ?? process.cwd(), input.cwd ?? '.');
}

export function terminalTools(): ToolDefinition[] {
  return [
    defineTool({
      id: 'shell.run',
      title: 'Run command',
      description:
        'Run a shell command (PowerShell on Windows, bash elsewhere) and return exit code and output. Dangerous commands are blocked or require confirmation.',
      module: 'terminal',
      categories: ['EXECUTE'],
      input: z.object({
        command: z.string().min(1).max(8000),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().max(1_800_000).optional(),
      }),
      assess: (i, ctx) => {
        const a = assessCommand(i.command);
        return {
          risk: a.risk === 'low' ? 'medium' : a.risk,
          blocked: a.blocked,
          reasons: a.reasons,
          target: cwdOf(i, ctx.workspace),
          description: `Run: ${i.command}${a.reasons.length ? ` (${a.reasons.join(', ')})` : ''}`,
        };
      },
      execute: (i, ctx) =>
        runCommand(i.command, { cwd: cwdOf(i, ctx.workspace), timeoutMs: i.timeoutMs, signal: ctx.signal }),
    }),
    defineTool({
      id: 'git.status',
      title: 'Git status',
      description: 'Show git status, current branch and recent commits for a repository.',
      module: 'terminal',
      categories: ['READ'],
      input: z.object({ cwd: z.string().optional() }),
      execute: async (i, ctx) => {
        const cwd = cwdOf(i, ctx.workspace);
        const [status, log] = await Promise.all([
          runCommand('git status --short --branch', { cwd, timeoutMs: 30_000 }),
          runCommand('git log --oneline -n 10', { cwd, timeoutMs: 30_000 }),
        ]);
        if (status.exitCode !== 0)
          throw new JarvisError('INVALID_INPUT', status.stderr || 'Not a git repository');
        return { status: status.stdout, recentCommits: log.stdout };
      },
    }),
    defineTool({
      id: 'git.diff',
      title: 'Git diff',
      description: 'Show the working-tree diff (optionally staged) of a repository.',
      module: 'terminal',
      categories: ['READ'],
      input: z.object({ cwd: z.string().optional(), staged: z.boolean().optional() }),
      execute: async (i, ctx) => {
        const r = await runCommand(`git diff ${i.staged ? '--staged' : ''} --stat --patch`, {
          cwd: cwdOf(i, ctx.workspace),
          timeoutMs: 30_000,
        });
        if (r.exitCode !== 0) throw new JarvisError('INVALID_INPUT', r.stderr);
        return { diff: r.stdout };
      },
    }),
  ] as ToolDefinition[];
}
