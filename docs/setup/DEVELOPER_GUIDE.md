# Developer Guide

## Layout
See [ARCHITECTURE.md](../architecture/ARCHITECTURE.md). Packages export TypeScript source; there is no per-package build step. Apps and services bundle with Vite or esbuild.

## Commands
| Command | What it does |
|---|---|
| `pnpm install` | Install workspace dependencies |
| `pnpm typecheck` | `tsc --noEmit` across packages, services, tests |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm test` | All Vitest projects |
| `pnpm test:unit` | Fast unit + security tests |
| `pnpm test:integration` | PostgreSQL-backed licensing/webhook tests and the local API server tests |
| `pnpm test:e2e` | Real Chromium: browser automation, PDF, and desktop UI (requires `apps/desktop/dist`) |
| `pnpm dev:orchestrator` | Local core in dev mode (`JARVIS_DEV=1`) |
| `pnpm dev:desktop` | Vite dev server for the 3D UI (`?core=http://127.0.0.1:7801&token=dev-token-change-me`) |
| `pnpm dev:license-api`, `pnpm dev:admin` | Backend and admin portal |
| `pnpm package:windows [--dev]` | Full Windows build and installer |

## Test prerequisites
- Integration tests use `TEST_DATABASE_URL` (default `postgres://jarvis:jarvis@127.0.0.1:5432/jarvis_test`). The test database schema is **dropped and recreated**, so never point it at real data.
- E2E tests find Chromium through `JARVIS_BROWSER_PATH` or `PLAYWRIGHT_BROWSERS_PATH`, and are skipped when neither is present. Build the desktop UI first (`pnpm --filter @jarvis/desktop build`).
- Orchestration tests use `tests/helpers/fake-provider.ts`, a scripted model that exists only in tests. The shipped application has no fake model.

## Conventions
- Never simulate success. A capability that isn't available reports `not_configured`, `unsupported` or `planned` together with the reason and what's needed to fix it.
- Every new tool declares permission categories and, when risk depends on the input, an `assess()`.
- External content returned to models goes through `wrapUntrusted`.
- Secrets: add the name to `SECRET_NAMES` in `services/orchestrator/src/core.ts` and read it through the secret store. Never read secrets from `process.env` at runtime.

## Running the desktop shell
- On Windows: `pnpm --filter @jarvis/desktop tauri dev`. The shell starts `jarvis-core` from `JARVIS_CORE_CMD` (for example `node services/orchestrator/dist/jarvis-core.cjs`) or from the file next to the executable.
- On Linux, the shell compiles for Windows (`x86_64-pc-windows-gnu`). Running it on Linux requires the WebKitGTK development packages.
