# Module Development Guide

A module is a group of tools with metadata, permissions, health, UI representation, tests and docs.

| Part               | Where                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata and tools | `packages/<module>/src/index.ts` exports `xxxTools(...)`: `ToolDefinition[]` with `module: '<module>'`                                                          |
| Permissions        | `categories` on each tool, plus `assess()` for input-dependent risk, targets and block rules                                                                    |
| Health             | `status()` / `statusReason()` report `active`, `not_configured`, `unsupported` and so on. The UI only shows a module as active when all of its tools are active |
| Skills             | Workflows that use the module's tools (`skills/src`)                                                                                                            |
| Agent handlers     | Add the tool ids to the relevant agents' `tools`                                                                                                                |
| UI representation  | Module stations in 3D (`apps/desktop/src/scenes/layout.ts` `MODULES`) and the Modules panel (automatic, grouped by `module`)                                    |
| Tests              | `tests/unit` for logic, `tests/e2e` for real integrations                                                                                                       |
| Docs               | This folder                                                                                                                                                     |

Register the tools in `services/orchestrator/src/core.ts`. Modules are discovered from the tool registry, so `/tools` and `/status` pick them up without further wiring.

Current modules: `file-system`, `terminal` (shell and git), `browser-control`, `documents` (PDF), `web-research` (search, fetch, SEO metadata), `computer-control` (Windows: screenshot, windows, launch, clipboard, mouse, keyboard, UI Automation inspection), `memory`.
