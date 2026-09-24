# Release Guide

1. **Version**: bump `version` in `package.json`, `apps/desktop/src-tauri/tauri.conf.json` and `apps/desktop/src-tauri/Cargo.toml`.
2. **Checks**: `pnpm typecheck && pnpm lint && pnpm test` must be green. CI runs the same on every push.
3. **Keys**: the license server keypair already exists. Only the PUBLIC key goes into the build:
   ```bash
   export JARVIS_LICENSE_PUBLIC_KEY="$(cat license-public.pem)"
   export JARVIS_LICENSE_API_URL=https://license.example.com
   export VITE_ACCOUNT_URL=https://account.example.com         # optional
   export JARVIS_SIGN_PFX=codesign.pfx JARVIS_SIGN_PASSWORD=... # recommended
   pnpm package:windows
   ```
   The build refuses to embed a private key and refuses a release without the public key.
4. **Outputs**: `dist/windows/JARVIS-Setup-<version>-x64.exe` and `.sha256`. `dist/windows/stage/` holds the unpacked files.
5. **Clean-machine verification** on a fresh Windows 10 and Windows 11 VM: install, launch, activate, add OpenRouter key, run a voice command in each language, run a browser task, a file task (approve and deny), a coding task (`coding.run_checks` on a sample repo), then expire the subscription from the admin portal and check that execution is blocked. Pay again and check it's restored. Update over the previous version and confirm data is kept, then uninstall.
6. **Publish** the installer and checksum. Record the release in `RELEASE_NOTES.md`.

## CI

`.github/workflows/ci.yml` runs lint, typecheck and tests (with PostgreSQL and Chromium) on Ubuntu, and builds the Windows installer natively on `windows-latest` (MSVC). Signing secrets are read from repository secrets when present.
