# JARVIS

A voice-first, 3D, multi-agent AI assistant for Windows. You talk to one assistant, JARVIS. Behind it, 74 specialist agents plan, research, write code, run the browser, handle files and control apps. Every protected action waits for your permission, and a server-verified subscription (PKR 4,000/month or PKR 40,000/year) unlocks task execution.

|            |                                                                                       |
| ---------- | ------------------------------------------------------------------------------------- |
| Desktop    | Tauri 2 shell, React 19 and Three.js 3D command space (WebGPU with WebGL fallback)    |
| Local core | Node 22 single-executable: orchestrator, agents, tools, memory, voice, licence client |
| Models     | OpenRouter (primary), any OpenAI-compatible local server                              |
| Backend    | Licence, billing and admin API (Fastify and PostgreSQL) plus an admin portal (React)  |
| Installer  | NSIS, per-user, with Start-menu shortcuts, upgrades and uninstall                     |

## Quick start (development)

Requirements: Node 22.12+, pnpm 10, Rust (stable), PostgreSQL 14+. The Windows build also needs NSIS; cross-building from Linux additionally needs mingw-w64.

```bash
pnpm install
cp .env.example .env              # fill in values, never commit
pnpm typecheck && pnpm test       # unit + integration + e2e (see docs/setup/DEVELOPER_GUIDE.md)

# Local core without the desktop shell (dev token, port 7801, licence bypass for development)
JARVIS_DEV=1 JARVIS_LICENSE_MODE=development pnpm dev:orchestrator
# 3D UI in a browser against that core
pnpm dev:desktop                  # http://localhost:1420
# Full desktop app (Tauri) — on Windows
pnpm --filter @jarvis/desktop tauri dev

# Licence API + admin portal
pnpm --filter @jarvis/license-api generate-keys
pnpm db:migrate && pnpm dev:license-api
pnpm dev:admin                    # http://localhost:5174
```

## Build the Windows installer

```bash
JARVIS_LICENSE_PUBLIC_KEY="..." JARVIS_LICENSE_API_URL="https://license.example.com" pnpm package:windows
# → dist/windows/JARVIS-Setup-<version>-x64.exe (+ .sha256)
```

Pass `--dev` to build an unlicensed development installer. See [docs/setup/RELEASE_GUIDE.md](docs/setup/RELEASE_GUIDE.md).

## Documentation

- [Architecture](docs/architecture/ARCHITECTURE.md) · [Decisions](docs/architecture/DECISIONS.md)
- [Installation](docs/setup/INSTALLATION.md) · [Developer guide](docs/setup/DEVELOPER_GUIDE.md) · [Release guide](docs/setup/RELEASE_GUIDE.md) · [Troubleshooting](docs/setup/TROUBLESHOOTING.md)
- [Provider configuration](docs/setup/PROVIDERS.md)
- [Agent development](docs/agents/AGENT_DEVELOPMENT.md) · [Skill development](docs/skills/SKILL_DEVELOPMENT.md) · [Module development](docs/modules/MODULE_DEVELOPMENT.md)
- [Licensing](docs/licensing/LICENSING.md) · [Security](docs/security/SECURITY.md)
- [User manual](docs/user-manual/USER_MANUAL.md)
- [Build status](BUILD_STATUS.md) · [Release notes](RELEASE_NOTES.md)

## Licence

Proprietary. See [LICENSE](LICENSE).
