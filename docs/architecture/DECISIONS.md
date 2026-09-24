# Architecture Decision Record

Each decision lists the context, the choice, and the consequences. Versions were
selected from the live npm / crates.io registries on 2026-09-24.

> **Research limitation:** the build environment could reach package registries
> but **not** vendor documentation sites (openrouter.ai, docs.stripe.com,
> tauri.app returned HTTP 403 through the sandbox proxy). API usage below is
> based on the providers' established public APIs; items marked **VERIFY**
> must be re-checked against current official docs before production launch.

## D1. Monorepo with pnpm workspaces, TypeScript everywhere except the native shell

- `packages/*` hold reusable runtime libraries; `services/*` deployable processes; `apps/*` UIs; `agents/` and `skills/` catalogs.
- TypeScript 5.9 (TypeScript 7 native preview exists but tooling support is still maturing), Vitest 5, ESLint 10, Prettier 3.
- Packages export TypeScript source; apps/services bundle with Vite/esbuild. One `tsc --noEmit` covers the whole repo.

## D2. Desktop: Tauri 2 + React 19 + Three.js (r186) via React Three Fiber 9

- Tauri gives a small native Windows shell on WebView2 with Rust access to the OS credential vault.
- 3D: Three.js with **WebGL2 by default; WebGPU opt-in (experimental)** (`three/webgpu` `WebGPURenderer`). Only built-in materials/instanced meshes are used so both renderers draw the same scene (custom GLSL `ShaderMaterial` is not supported by WebGPURenderer).
- Dense information lives in accessible 2D "glass" panels layered over the 3D space; `drei` `Html` labels only for hovered/selected nodes (performance).
- Quality tiers + drei `PerformanceMonitor` auto-downgrade; reduced-motion mode.

## D3. Local core as a separate process (Node single-executable) instead of logic in the WebView

- Agents need file system, processes, browsers and SQLite, which a WebView cannot do safely.
- `services/orchestrator` runs as `jarvis-core.exe`, a Node 22 **single-executable application** (official Node Windows binary + SEA blob). It binds **127.0.0.1 only**, requires a **per-launch 256-bit session token**, restricts CORS to the Tauri origin, and exits when the shell's stdin pipe closes.
- The shell passes the session token and the secrets master key over the child's **stdin** (never argv/env, which other processes can read).
- `playwright-core` cannot be bundled, so it ships as a plain folder (`core-modules/`) loaded by a filesystem `require`.

## D4. Secrets: AES-256-GCM file + master key in Windows Credential Manager

- `keyring` crate (Credential Manager on Windows). Secret values never leave the core via the API (write-only), are redacted from logs/audit/memory and are scrubbed from child-process environments.

## D5. Model gateway: OpenRouter first, provider abstraction

- OpenRouter's OpenAI-compatible `POST /api/v1/chat/completions` (+ SSE streaming, tool calls) and `GET /api/v1/models`; attribution headers `HTTP-Referer`, `X-Title`. **VERIFY** header names and audio-input support per model.
- `ModelRouter` maps roles (fast, reasoning, coding, vision, audio) to ordered fallback chains; retries on 429/5xx/404/400, not on auth errors; tracks tokens, latency and errors; keeps a redacted request log.
- Any OpenAI-compatible server (Ollama, LM Studio, vLLM) can be added as the `local` provider.

## D6. Agents: one runtime, many configured specialists

- 74 built-in specialists are **data** (instructions, capabilities, tool/skill allow-lists, permission categories, model role) executed by one `AgentWorker` tool-calling loop. This avoids 70 disconnected implementations and makes dynamic creation (Agent Builder) safe: new agents are validated against the same schema and may only reference existing tools.
- Typed event bus with the 11 required event types; DAG task engine with bounded parallelism, retries, timeouts and cancellation.
- Review workflow (reviewer agent → correction round) and final verification (artifacts must exist) before one synthesised answer.
- Metrics are operational only (success rate, latency, tool errors, review corrections).

## D7. Permissions: human-in-the-loop by default

- Categories READ/WRITE/EXECUTE/NETWORK/BROWSER/SYSTEM/SENSITIVE/DESTRUCTIVE; risk = max(category risk, dynamic assessment).
- Only the UI channel can approve. Critical (destructive) actions always prompt, even with rules. A hard block-list (disk formatting, disabling Defender/firewall, shadow-copy deletion, credential dumping) never runs.
- Web/file/tool output is wrapped in an `<untrusted_content>` envelope and scanned for injection patterns.

## D8. Memory: SQLite (node:sqlite) + FTS5 trigram

- No native addon to ship; trigram tokenizer handles English, Urdu and Chinese; LIKE fallback for 1–2 character CJK queries. Embeddings were **not** added: FTS covers current retrieval needs without an extra model dependency or cost. The store interface allows adding vectors later.
- Lessons are stored unverified and only reused once verified. The base model is never modified.

## D9. Voice

- STT providers: OpenAI-compatible `/audio/transcriptions` (Whisper, Groq, local servers) and OpenRouter audio-capable chat models (`input_audio`). **VERIFY** model availability.
- Language detection: script analysis + romanised-Urdu heuristic + provider-reported language; registry-driven so languages can be added.
- TTS: Windows voices through `speechSynthesis` (no cost, offline); optional OpenAI-compatible `/audio/speech`.
- Barge-in via client-side VAD while speaking.

## D10. Windows automation through PowerShell 5.1 + .NET/UI Automation

- Present on every supported Windows; no native addon. Parameters are passed as base64 JSON so user text is never parsed as script.

## D11. Browser automation: playwright-core driving Microsoft Edge

- Edge is preinstalled on Windows, so no browser download. A dedicated JARVIS profile is used, never the user's everyday profile.

## D12. Licensing: server-signed Ed25519 JWT entitlements

- License server (Fastify 5 + PostgreSQL) is the source of truth. Tokens carry `srvNow`, device fingerprint hash, entitlement end and a client nonce (anti-replay).
- Desktop embeds only the **public** key (build fails if a private key is supplied). Clock tampering is handled with a server-anchored trusted time + monotonic offline counter; the offline window is bounded (default 72 h).
- Expiry never deletes user data; it blocks premium execution only.

## D13. Billing: provider-agnostic

- `BillingProvider` interface. Implemented: **manual bank transfer** (admin confirms), **Stripe** Checkout (REST, signature verification per Stripe's documented scheme — **VERIFY PKR support for your account**), and a **generic HMAC-signed gateway bridge** for Pakistani gateways. No Pakistani gateway API was implemented directly because its current official documentation could not be verified from this environment.

## D14. Installer: custom NSIS script

- Built with `makensis` on Windows or Linux. Per-user install (no admin), Start-menu/desktop shortcuts, Add/Remove Programs entry, in-place upgrades, WebView2 runtime check, optional removal of user data on uninstall. The Tauri shell cross-compiles to `x86_64-pc-windows-gnu` (ships `WebView2Loader.dll`) or builds natively with MSVC in CI.
