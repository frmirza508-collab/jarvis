import { z } from 'zod';
import { defineTool, type ToolDefinition } from '@jarvis/tool-runtime';
import { MEMORY_SCOPES, type MemoryStore } from '@jarvis/memory';

export function memoryTools(memory: MemoryStore): ToolDefinition[] {
  return [
    defineTool({
      id: 'memory.search',
      title: 'Search memory',
      description: 'Search JARVIS long-term memory (preferences, projects, knowledge, verified lessons).',
      module: 'memory',
      categories: ['READ'],
      input: z.object({ query: z.string().min(1), scopes: z.array(z.enum(MEMORY_SCOPES)).optional(), limit: z.number().int().max(50).optional() }),
      execute: async (i) => memory.search(i.query, { scopes: i.scopes, limit: i.limit }).map((m) => ({ id: m.id, scope: m.scope, content: m.content, verified: m.verified, tags: m.tags })),
    }),
    defineTool({
      id: 'memory.remember',
      title: 'Remember',
      description: 'Store a durable fact or note for future tasks (project, knowledge or agent scope). Never store secrets.',
      module: 'memory',
      categories: ['WRITE'],
      input: z.object({ content: z.string().min(3).max(4000), scope: z.enum(['project', 'knowledge', 'agent', 'department', 'global']), scopeId: z.string().optional(), tags: z.array(z.string()).optional() }),
      assess: () => ({ risk: 'low' }),
      execute: async (i, ctx) => {
        const m = memory.remember({ ...i, source: ctx.actor, verified: false });
        return { id: m.id, stored: true };
      },
    }),
  ] as ToolDefinition[];
}
