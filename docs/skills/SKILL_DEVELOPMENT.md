# Skill Development Guide

**Tool** = one system capability · **Skill** = reusable workflow · **Agent** = reasoning worker that uses both.

```ts
import { z } from 'zod';
import { defineSkill } from '@jarvis/skills';

export const summariseFolder = defineSkill({
  id: 'office.summarise_folder',
  name: 'Summarise folder',
  description: 'Read text files in a folder and write a summary report.',
  category: 'office',
  tools: ['fs.list', 'fs.read', 'fs.write'], // the ONLY tools this skill may call
  usesModel: true,
  input: z.object({ path: z.string(), out: z.string() }),
  run: async (i, ctx) => {
    const files = (await ctx.tool('fs.list', { path: i.path })) as Array<{ name: string; type: string }>;
    // ... ctx.progress('...'), ctx.llm('prompt', { role: 'fast' })
    return { written: i.out };
  },
});
```

Then add it to `SKILL_CATALOG` in `skills/src/index.ts` and list its id in the `skills` of the agents that should use it.

- Tool calls from a skill still pass through permissions and are audited under the calling agent.
- If any tool a skill needs is unavailable, the skill is hidden from agents automatically.
- Wrap external content with `wrapUntrusted` before sending it to `ctx.llm`.
- Skill run and failure counts are shown in Modules.

Built-in skills: `coding.inspect_repo`, `coding.run_checks`, `research.deep` (question → search → sources → claims → cross-check → cited answer that separates facts from inference), `docs.report_pdf`, `marketing.seo_audit`.
