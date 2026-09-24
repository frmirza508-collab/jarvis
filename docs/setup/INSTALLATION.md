# Installation Guide

## End users (Windows 10 1809+ / Windows 11, 64-bit)
1. Run `JARVIS-Setup-<version>-x64.exe`. No administrator rights are needed; JARVIS installs to `%LOCALAPPDATA%\Programs\JARVIS`.
2. If the installer reports that the **Microsoft Edge WebView2 Runtime** is missing (rare on Windows 11), it opens Microsoft's download page. Install it, then start JARVIS.
3. Start JARVIS from the Start menu. On first run:
   - **Account** → paste your license key (`JRV-…`) → **Activate**.
   - **Settings → Providers** → paste your **OpenRouter API key** → **Save** → **Test**.
   - Optional: Brave or Tavily key for web research; a Whisper-compatible key for speech recognition if you don't use an OpenRouter audio model.
   - **Settings → Voice** → pick your recognition language, or leave it on Auto. For Urdu or Chinese speech output, install those voices in **Windows Settings › Time & language › Speech**.
4. Allow microphone access when Windows asks (Settings › Privacy › Microphone).

Verify the download: compare `certutil -hashfile JARVIS-Setup-<version>-x64.exe SHA256` with the published `.sha256`.

### Update
Run the newer installer. It stops JARVIS, replaces the program files and keeps your data (`%APPDATA%\JARVIS`) and keys.

### Uninstall
Use **Settings › Apps › JARVIS › Uninstall** or the Start-menu uninstaller. Your data is kept unless you tick "Also remove JARVIS data". Your own documents are never touched.

## Operators (license server)
See [licensing/LICENSING.md](../licensing/LICENSING.md#deployment) and `infra/deployment/`.
