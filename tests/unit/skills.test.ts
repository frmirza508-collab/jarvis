import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { SkillRegistry } from '@jarvis/skills';
import { FileIndex, fileSystemTools } from '@jarvis/file-system';
import { terminalTools } from '@jarvis/terminal';
import { SKILL_CATALOG, checkCommands } from '@jarvis/skills-catalog';
import { makeRuntime } from '../helpers/runtime.js';

function registry() {
  const rt = makeRuntime(async () => 'allow_once');
  for (const t of [...fileSystemTools(new FileIndex()), ...terminalTools()]) rt.tools.register(t);
  const skills = new SkillRegistry(rt.tools);
  for (const s of SKILL_CATALOG.filter((s) => s.id.startsWith('coding.'))) skills.register(s);
  return { rt, skills };
}

describe('coding skills (real shell)', () => {
  it('detects the project and runs its checks, reporting pass/fail honestly', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-proj-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        scripts: {
          lint: 'node -e "process.exit(0)"',
          test: 'node -e "console.log(\'1 failing\'); process.exit(1)"',
        },
      }),
    );
    const { skills } = registry();
    const out = (await skills.run(
      'coding.run_checks',
      { path: dir },
      { actor: 'testing-engineer', workspace: dir, llm: async () => '' },
    )) as { allPassed: boolean; results: Array<{ command: string; ok: boolean; output: string }> };
    expect(out.results.map((r) => [r.command, r.ok])).toEqual([
      ['npm run lint', true],
      ['npm run test', false],
    ]);
    expect(out.allPassed).toBe(false);
    expect(out.results[1]!.output).toContain('1 failing');
  });

  it('maps project types to check commands', () => {
    expect(checkCommands(['rust', 'python'], {}, 'npm')).toEqual([
      'cargo check',
      'cargo test',
      'python -m pytest -q',
    ]);
    expect(checkCommands(['node'], { build: 'x', typecheck: 'y' }, 'pnpm')).toEqual([
      'pnpm run typecheck',
      'pnpm run build',
    ]);
  });

  it('refuses tools outside the skill declaration', async () => {
    const { rt, skills } = registry();
    skills.register({
      id: 'bad.skill',
      name: 'bad',
      description: 'tries undeclared tool',
      category: 'x',
      tools: ['fs.list'],
      usesModel: false,
      input: (await import('zod')).z.object({}),
      run: async (_i, ctx) => ctx.tool('shell.run', { command: 'echo hi' }),
    });
    await expect(skills.run('bad.skill', {}, { actor: 'a', llm: async () => '' })).rejects.toThrow(
      /may not use tool shell.run/,
    );
    expect(rt.tools.recentCalls().length).toBe(0);
  });
});
