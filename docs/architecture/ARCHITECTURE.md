# JARVIS Architecture

```
┌──────────────────────────── Windows PC ────────────────────────────┐
│  JARVIS.exe (Tauri 2, Rust)                                        │
│   • WebView2 UI: React + Three.js (WebGPU/WebGL) 3D command space   │
│   • master key in Windows Credential Manager                        │
│   • spawns ─────────────┐ stdin: {token, masterKey}                 │
│                         ▼                                           │
│  jarvis-core.exe (Node 22 SEA) ── 127.0.0.1:<random> HTTP + WS      │
│   ├─ Orchestrator (planner → DAG → specialists → review → verify)   │
│   ├─ Agent registry (74 specialists, dynamic agents)                │
│   ├─ Tool runtime ── permission manager ── audit log (hash chain)   │
│   │    fs · shell/git · browser (Edge via playwright-core) · web    │
│   │    documents (PDF) · computer control (PowerShell/.NET/UIA)     │
│   ├─ Skills (inspect repo, run checks, deep research, PDF, SEO)     │
│   ├─ Memory (SQLite FTS5: session, prefs, projects, lessons …)      │
│   ├─ Model router → OpenRouter (+ local OpenAI-compatible)          │
│   ├─ Voice: STT providers, language registry, TTS                   │
│   └─ License client (Ed25519 verify, trusted time, offline window)  │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │ HTTPS
┌─────────────────────────────────▼──────────────────────────────────┐
│ License & billing API (Fastify + PostgreSQL)                        │
│  auth · plans · subscriptions · licenses · devices · payments       │
│  webhooks (Stripe / signed gateway) · manual payments · audit       │
│  expiry reconciler · rate limits · Ed25519 signer (private key)     │
└─────────────────────────────────▲──────────────────────────────────┘
                                  │ HTTPS (admin token)
                     Admin portal (React, static hosting)
```

## Repository map

| Path                                                                                      | Purpose                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`                                                                         | Contracts: permission categories, typed agent events, errors, logger, language registry, capability status, metrics                                                            |
| `packages/security`                                                                       | Redaction, command-risk assessment/block-list, prompt-injection envelope, path safety, encrypted secret store                                                                  |
| `packages/audit`                                                                          | Append-only, SHA-256 hash-chained audit log                                                                                                                                    |
| `packages/permissions`                                                                    | Policy + rules + human confirmation; critical actions always confirm                                                                                                           |
| `packages/agent-communication`                                                            | Typed agent bus (TASK_REQUEST … COMPLETED)                                                                                                                                     |
| `packages/task-engine`                                                                    | DAG executor: parallelism, retries, timeouts, cancellation, live events                                                                                                        |
| `packages/model-router`                                                                   | Provider interface, OpenAI-compatible + OpenRouter adapters, role routing/fallback, usage stats (this package also covers the "provider-adapters" role from the target layout) |
| `packages/tool-runtime`                                                                   | Tool definitions (zod schemas → JSON schema), permission-gated invocation, audit                                                                                               |
| `packages/skills`                                                                         | Skill registry (tool-restricted workflows)                                                                                                                                     |
| `packages/agent-registry`                                                                 | Agent schema, lifecycle, health, metrics, capability routing                                                                                                                   |
| `packages/agent-runtime`                                                                  | AgentWorker tool loop, Orchestrator (plan/delegate/review/verify/synthesise/learn), memory tools                                                                               |
| `packages/memory`                                                                         | SQLite memory layers, lessons, preferences, task history, retention (also the "knowledge" store)                                                                               |
| `packages/file-system`, `terminal`, `browser-control`, `web-research`, `computer-control` | Tool modules                                                                                                                                                                   |
| `packages/voice`                                                                          | Language detection, STT/TTS providers, language manager (also the "speech" role)                                                                                               |
| `packages/billing-core`, `packages/licensing`                                             | Plans, entitlement policy, provider interface; token signing/verification and tamper-resistant guard                                                                           |
| `agents/`                                                                                 | Built-in specialist catalog                                                                                                                                                    |
| `skills/`                                                                                 | Built-in skill catalog                                                                                                                                                         |
| `services/orchestrator`                                                                   | Local core process (API server, license client, SEA entry)                                                                                                                     |
| `services/license-api`                                                                    | License/billing/admin backend (also the "billing" and "notifications" roles via webhooks/audit)                                                                                |
| `apps/desktop`                                                                            | Tauri shell + 3D UI                                                                                                                                                            |
| `apps/admin`                                                                              | Admin portal                                                                                                                                                                   |
| `infra/database/migrations`                                                               | PostgreSQL schema                                                                                                                                                              |
| `scripts/`                                                                                | Build, packaging, installer                                                                                                                                                    |
| `tests/`                                                                                  | Cross-package unit, security, licensing, integration, e2e and desktop UI tests                                                                                                 |

## Request lifecycle

1. UI `POST /requests` (entitlement checked first; 402 if not premium).
2. Planner (reasoning model, JSON) returns `direct` or a task DAG over known agent ids (unknown ids are re-routed).
3. `TaskGraph` runs independent nodes in parallel; each node = `AgentWorker.run` (tool-calling loop limited to the agent's tool/skill allow-list). Tool calls go through `ToolRuntime.invoke` → safety assessment → `PermissionManager` (may prompt the user over WebSocket) → execution → audit.
4. Optional review by the agent's reviewer; one correction round on rejection.
5. Final verification (declared file artifacts must exist).
6. Synthesis in the user's language (streamed deltas), history recorded, lesson proposed.

## Data locations (Windows)

- Program: `%LOCALAPPDATA%\Programs\JARVIS`
- Data: `%APPDATA%\JARVIS` → `settings.json`, `secrets.enc.json` (AES-GCM), `memory.db`, `audit.jsonl`, `browser-profile\`, `logs\core.log`
- Master key: Windows Credential Manager, target `secrets-master-key.JARVIS`
- Default workspace: `Documents\JARVIS`
