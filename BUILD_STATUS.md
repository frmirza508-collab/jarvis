# JARVIS Build Status

Last updated: 2026-09-24. Build environment: Linux container (Node 22.22, Rust 1.94, PostgreSQL 16, Chromium, mingw-w64, NSIS, Wine). No Windows machine was available.

Status key: ✅ done and verified here · 🟡 implemented, needs verification on real Windows or with real provider accounts · ⛔ not implemented (planned)

## Phases

| Phase                   | Status | Notes                                                                                                                                                                                                                                            |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 Inspect               | ✅     | Empty repository; package read                                                                                                                                                                                                                   |
| 1 Research              | 🟡     | Current versions came from the npm and crates.io registries. Vendor documentation sites were blocked by the sandbox, so API choices rest on established APIs and are marked **VERIFY** in `docs/architecture/DECISIONS.md`                       |
| 2 Bootstrap             | ✅     | pnpm monorepo, TS 5.9, ESLint 10, Prettier, Vitest 5                                                                                                                                                                                             |
| 3 Core runtime          | ✅     | Bus, DAG engine, agent/tool/skill registries, permissions, audit, logging, config, secrets                                                                                                                                                       |
| 4 Model router          | ✅     | OpenRouter and OpenAI-compatible adapters, role fallback, streaming, usage stats, redacted log, settings UI. 🟡 Not exercised against the live OpenRouter API (no key available)                                                                 |
| 5 Agents                | ✅     | 74 specialists on one runtime; delegation, parallelism, review/correction, verification, cancellation, dynamic agents, metrics                                                                                                                   |
| 6 Memory                | ✅     | Session, preference, project, task, agent, department, global, knowledge and lesson layers; retention; inspection UI. Embeddings intentionally omitted (see D8)                                                                                  |
| 7 Voice                 | 🟡     | Mic capture, VAD, WAV encoding, STT providers, language detection (en/ur/zh), Windows TTS, barge-in. API path tested with a stand-in STT endpoint; real microphones and Windows voices need a Windows PC                                         |
| 8 Windows control       | 🟡     | PowerShell/.NET/UI Automation driver for screenshots, windows, launch, clipboard, mouse, keyboard and inspection, with permission gates. Scripts not executed on real Windows (Wine lacks PowerShell)                                            |
| 9 Browser               | ✅     | Navigation, extraction, forms, multi-step flows, downloads, uploads, screenshots, PDF, injection defences, all tested against real Chromium                                                                                                      |
| 10 3D UI                | ✅     | 11 views plus permission prompt, notifications and status bar; WebGPU→WebGL fallback verified; screenshots in `test-results/desktop`                                                                                                             |
| 11 Billing & licensing  | ✅     | Full flow tested on PostgreSQL with the real desktop licence client                                                                                                                                                                              |
| 12 Admin portal         | ✅     | Every page listed in the spec; browser-tested (login, payment, licence, revoke, plans, audit, settings)                                                                                                                                          |
| 13 Integrations         | 🟡     | AI and payment adapters done. ⛔ email, calendar, cloud storage, Git hosting APIs, messaging and analytics integrations not implemented; the corresponding agents work with local files and the browser                                          |
| 14 Security review      | ✅     | `docs/security/SECURITY.md` threat table; findings fixed (see below)                                                                                                                                                                             |
| 15 Testing              | ✅     | 130 tests across 24 files, all passing (unit, security, integration, licensing, e2e, desktop UI)                                                                                                                                                 |
| 16 Installer            | 🟡     | Native x64 NSIS installer built from Linux. Silent install and uninstall checked under Wine: files, Start-menu shortcuts, Add/Remove Programs entry, user data kept on uninstall. The interactive UI and WebView2 launch still need real Windows |
| 17 Release verification | 🟡     | Windows core executable ran under Wine (API, encrypted secrets, SQLite, audit). Clean-VM checklist in `docs/setup/RELEASE_GUIDE.md` still to do                                                                                                  |
| 18 Documentation        | ✅     | All requested guides                                                                                                                                                                                                                             |

## Defects found and fixed during testing

1. CORS preflight rejected PUT, PATCH and DELETE on the local core and the licence API, which broke saving settings and keys.
2. A fast reply could arrive over the WebSocket before the HTTP response and be lost in the UI.
3. The request endpoint accepted work (HTTP 202) with no entitlement when no licence client was configured.
4. The core could outlive the desktop shell (stdin end not observed); a parent watchdog was added.
5. The admin portal CSP hard-coded the API origin; it is now generated from the build configuration.
6. Server outages must not revoke the cached entitlement: only 401/403/404 answers clear it.

## Known limitations

- Speech recognition needs a configured provider (OpenRouter audio model or Whisper-compatible key). Voice quality for Urdu and Chinese output depends on which Windows voices are installed.
- Auto-update notifies the user and opens the verified download; there is no silent in-place updater.
- Admin authentication is password-based (scrypt, sessions). Add TOTP/SSO before exposing it publicly.
- Stripe PKR availability and the OpenRouter audio-input models must be confirmed per account.
- There are no direct Pakistani payment gateway adapters; use the signed gateway bridge.
- Default OpenRouter model ids are starting points. Confirm them in Settings → Models.
