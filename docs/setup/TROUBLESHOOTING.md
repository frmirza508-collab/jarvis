# Troubleshooting

| Symptom                            | Cause / fix                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "JARVIS core unavailable" on start | See `%APPDATA%\JARVIS\logs\core.log`. Common causes: antivirus quarantined `jarvis-core.exe` (restore it and add an exclusion), or the data folder isn't writable. |
| "credential vault" error           | Windows Credential Manager is unavailable for this account. Sign in with a normal user profile, not a temporary one.                                               |
| "No AI model configured"           | Settings → Providers → add an OpenRouter key → Test.                                                                                                               |
| Model errors 401/402               | The OpenRouter key is invalid or out of credit.                                                                                                                    |
| Model errors 404/400               | The model id in Settings → Models no longer exists. Pick another from the list.                                                                                    |
| "No active subscription" / 402     | Account → Activate. If you already paid, click **Check now**. Payment confirmation may take a few minutes.                                                         |
| "System clock appears incorrect"   | Fix the Windows date and time (enable automatic time), then connect to the internet and click **Check now**.                                                       |
| "must reach the license server"    | JARVIS has run offline longer than the allowed window (default 72 h). Reconnect.                                                                                   |
| Device limit reached               | Deactivate an old device (Account on that PC, or ask support).                                                                                                     |
| Microphone does nothing            | Allow microphone access in Windows Privacy settings, and check that the mic button is green. Speech recognition needs an STT provider (see Modules).               |
| No Urdu or Chinese voice           | Windows Settings › Time & language › Speech › Add voices. Or configure cloud TTS.                                                                                  |
| Web search "not configured"        | Add a Brave or Tavily key. Fetching specific pages works without one.                                                                                              |
| Browser tasks fail                 | Microsoft Edge must be installed. Set `JARVIS_BROWSER_PATH` to use another Chromium browser.                                                                       |
| 3D view slow                       | Settings → Display → Quality: Low, or Reduced motion. Update your GPU drivers.                                                                                     |
| WebView2 missing                   | Install from https://go.microsoft.com/fwlink/p/?LinkId=2124703                                                                                                     |
| Admin portal CORS errors           | Add the portal's origin to `ADMIN_ORIGINS` on the license API.                                                                                                     |
| Webhooks rejected                  | Check the webhook secret, keep server clocks in sync (NTP), and send the raw body unchanged.                                                                       |
