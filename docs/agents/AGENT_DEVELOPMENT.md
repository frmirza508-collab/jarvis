# Agent Development Guide

JARVIS runs every specialist on one runtime (`AgentWorker`). An agent is a **definition**:

```ts
// agents/src/index.ts (built-in) — validated by AgentDefinitionSchema
{
  id: 'tax-assistant',                  // kebab-case, unique
  name: 'Tax Assistant',
  department: 'business',               // executive|engineering|research|design|marketing|business|security|knowledge-ai|qa-operations
  description: 'Prepares Pakistani tax filing checklists from documents.',
  capabilities: ['tax', 'documents'],   // used by the planner and findByCapability()
  tools: ['fs.read', 'fs.search', 'documents.pdf', 'memory.search'],  // hard allow-list
  skills: ['docs.report_pdf'],          // skills exposed as callable functions
  permissions: ['READ', 'WRITE'],       // categories it may request
  modelRole: 'reasoning',               // fast|reasoning|coding|vision
  reviewer: 'qa-reviewer',              // optional: reviews deliverables when the plan sets review=true
  instructions: 'You are the Tax Assistant inside JARVIS. ...',
}
```

## Rules

- Tools outside `tools` are refused at runtime, even if the model asks for them. That failure is counted as a tool error.
- Keep instructions focused. Shared rules (untrusted-content policy, language, honesty, permissions) are added by the runtime.
- Give the agent the fewest tools and permission categories it needs.
- Metrics are recorded automatically: tasks started/succeeded/failed, latency, tool errors, review corrections. After three consecutive failures an agent is marked `degraded`, and routing prefers healthier agents.

## Dynamic agents

- UI: **Agents → Create a new specialist**, or `POST /agents {brief}` on the local API. The Agent Builder drafts a definition, the schema validates it, and it is rejected if it references unknown tools. Dynamic agents can be removed; built-in agents can only be disabled.

## Communication contract

Workers emit typed events on the bus: `TASK_ACCEPTED`, `TASK_PROGRESS`, `TASK_RESULT` / `TASK_FAILED`, `BLOCKED` (permission denied), and `REVIEW_REQUEST` / `REVIEW_RESULT`. Upstream outputs (`TaskOutput`: summary, artifacts, evidence) are passed to dependent tasks.

## Testing

Use `ScriptedProvider` (tests only) to script model replies, and assert on bus events, files and metrics. See `services/orchestrator/test/unit/orchestrator.test.ts`.
