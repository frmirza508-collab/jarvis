import { z } from 'zod';
import { JarvisError } from '@jarvis/shared';
import type { ToolRuntime, ToolContext } from '@jarvis/tool-runtime';

/**
 * Tool  = one direct system capability (fs.read, shell.run, browser.open).
 * Skill = reusable multi-step workflow composed of tools and model calls.
 * Agent = reasoning worker that chooses tools and skills.
 */
export interface SkillContext extends ToolContext {
  tool: (id: string, input: unknown) => Promise<unknown>;
  /** Ask the language model (role-routed). Returns plain text. */
  llm: (prompt: string, opts?: { role?: 'fast' | 'reasoning' | 'coding'; system?: string; json?: boolean }) => Promise<string>;
  progress: (message: string) => void;
}

export interface SkillDefinition<S extends z.ZodType = z.ZodType, O = unknown> {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Tools the skill may call; enforced at runtime. */
  tools: string[];
  usesModel: boolean;
  input: S;
  run: (input: z.infer<S>, ctx: SkillContext) => Promise<O>;
}

export function defineSkill<S extends z.ZodType, O>(s: SkillDefinition<S, O>): SkillDefinition<S, O> {
  return s;
}

export interface SkillStats {
  runs: number;
  failures: number;
}

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  private stats = new Map<string, SkillStats>();

  constructor(private readonly tools: ToolRuntime) {}

  register(s: SkillDefinition<z.ZodType, unknown>): void {
    for (const t of s.tools) if (!this.tools.get(t)) throw new Error(`Skill ${s.id} references unknown tool ${t}`);
    this.skills.set(s.id, s);
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  getStats(id: string): SkillStats {
    return this.stats.get(id) ?? { runs: 0, failures: 0 };
  }

  async run(
    id: string,
    rawInput: unknown,
    base: ToolContext & { llm: SkillContext['llm']; progress?: (m: string) => void },
  ): Promise<unknown> {
    const s = this.skills.get(id);
    if (!s) throw new JarvisError('NOT_FOUND', `Unknown skill ${id}`);
    const parsed = s.input.safeParse(rawInput);
    if (!parsed.success) throw new JarvisError('INVALID_INPUT', `Invalid input for skill ${id}: ${parsed.error.message}`);
    const st = this.getStats(id);
    st.runs++;
    this.stats.set(id, st);
    const ctx: SkillContext = {
      ...base,
      progress: base.progress ?? (() => {}),
      tool: (toolId, input) => {
        if (!s.tools.includes(toolId)) throw new JarvisError('PERMISSION_DENIED', `Skill ${id} may not use tool ${toolId}`);
        return this.tools.invoke(toolId, input, base);
      },
    };
    try {
      return await s.run(parsed.data, ctx);
    } catch (e) {
      st.failures++;
      throw e;
    }
  }
}
