# Release Notes

## 0.1.0 — first build (2026-09-24)

### Desktop (Windows)

- 3D command space: JARVIS core, voice field, agent constellation, live task graph, module stations and a memory cloud, with holographic glass panels. WebGPU with automatic WebGL fallback, quality tiers and reduced motion.
- Voice-first input in English, Urdu (including Roman Urdu) and Mandarin; barge-in; Windows voices for speech output.
- Permission prompts with risk levels, "always allow here" rules, and a hard block-list for destructive system changes.
- Account view: licence activation, subscription status, plans (PKR 4,000/month, PKR 40,000/year).
- Update check against the licence server, with a SHA-256 checksum.

### Local core

- Orchestrator with planning, a parallel DAG, 74 specialists, review/correction, final verification and synthesis in the user's language.
- Tools: files (indexed search, CRUD, delete with confirmation), shell and git, browser automation (Edge), PDF documents, web search/fetch/SEO metadata, Windows control, memory.
- Skills: repository inspection, running project checks, cited deep research, PDF reports, SEO audits.
- Persistent memory with verified lessons; hash-chained audit log; encrypted secrets.

### Server

- Licence and billing API: accounts, plans, subscriptions (active/past_due/canceled/expired/suspended), licence keys, device limits, Ed25519-signed entitlements, expiry reconciler, manual bank-transfer payments, Stripe and signed-gateway webhooks, rate limits and audit.
- Admin portal: dashboard, customers, subscriptions, licences, devices, payments and webhooks, audit log, plans, settings.

### Installer

- Per-user NSIS installer with shortcuts, Add/Remove Programs entry, in-place upgrade, WebView2 check, and optional removal of user data on uninstall.

See [BUILD_STATUS.md](BUILD_STATUS.md) for verification status and known limitations.
