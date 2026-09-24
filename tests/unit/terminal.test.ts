import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { terminalTools } from '@jarvis/terminal';
import { makeRuntime } from '../helpers/runtime.js';

describe('terminal tools', () => {
  it('runs commands after permission and returns output', async () => {
    const confirm = vi.fn(async () => 'allow_once' as const);
    const rt = makeRuntime(confirm);
    for (const t of terminalTools()) rt.tools.register(t);
    const r = (await rt.tools.invoke(
      'shell.run',
      { command: process.platform === 'win32' ? 'Write-Output hi' : 'echo hi' },
      { actor: 'test', workspace: os.tmpdir() },
    )) as { exitCode: number; stdout: string };
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi');
    expect(confirm).toHaveBeenCalledTimes(1); // EXECUTE is high risk: shell commands always ask unless the user created a rule
  });
  it('never runs blocked commands', async () => {
    const confirm = vi.fn(async () => 'allow_once' as const);
    const rt = makeRuntime(confirm);
    for (const t of terminalTools()) rt.tools.register(t);
    await expect(
      rt.tools.invoke('shell.run', { command: 'rm -rf /' }, { actor: 'test' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(confirm).not.toHaveBeenCalled();
  });
  it('scrubs JARVIS secrets from child environment', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-shouldnotleak';
    const rt = makeRuntime();
    for (const t of terminalTools()) rt.tools.register(t);
    const r = (await rt.tools.invoke(
      'shell.run',
      {
        command:
          process.platform === 'win32'
            ? 'Write-Output $env:OPENROUTER_API_KEY'
            : 'echo "k=$OPENROUTER_API_KEY"',
      },
      { actor: 't' },
    )) as { stdout: string };
    expect(r.stdout).not.toContain('shouldnotleak');
    delete process.env.OPENROUTER_API_KEY;
  });
});
