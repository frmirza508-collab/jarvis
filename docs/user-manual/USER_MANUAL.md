# JARVIS User Manual

JARVIS is your personal AI operator for Windows. You talk to one assistant. Behind it, a team of specialists does the work: research, writing, coding, files, the browser and your apps. Nothing risky happens without your approval.

## 1. Getting started

1. **Account** (top bar) → enter your license key → **Activate**.
2. **Settings → Providers** → paste your **OpenRouter key** → **Save** → **Test**.
3. Optional: add a web-search key (Brave or Tavily) and choose your voice language in **Settings → Voice**.

## 2. Talking to JARVIS

- **Type** in the Command panel and press **Enter**. **Ctrl+K** focuses the box from anywhere.
- **Speak:** click the microphone. Speak, then pause, and JARVIS sends what you said automatically. Enable **Hands-free** in Settings → Voice to have it start listening whenever you speak.
- **Languages:** English, اردو (Urdu, including Roman Urdu) and 中文 (Mandarin). JARVIS replies in the language you used.
- **Interrupt:** start speaking while JARVIS is talking and it stops to listen.
- **Cancel** a running task from its message or from the Tasks view.

Examples:

- "Research 10 competitors of Acme Traders, compare pricing, and save a PDF report in Documents."
- "Run the tests in D:\projects\shop and explain the failures."
- "میرے ڈاؤن لوڈز میں اس مہینے کی پی ڈی ایف فائلیں ایک فولڈر میں رکھ دو"
- "打开记事本并写下今天的待办事项"

## 3. Permissions

When a specialist needs a protected action (running a command, writing or deleting files, controlling apps, uploading, capturing the screen), a **Permission required** card shows exactly what will happen and how risky it is.

- **Deny**: the action is not performed, and JARVIS tells you what it could not do.
- **Allow once**: allowed this time only.
- **Always allow here**: creates a rule for that action and location. Manage your rules in Settings → Permissions.
- Deleting files always asks. Dangerous system changes (formatting disks, disabling Windows security) are never performed.

## 4. The 3D command space

| View (key)      | What you see                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Command (1)     | The JARVIS core. It pulses while listening or working, and the voice ring follows your voice        |
| Voice (2)       | Voice status and providers                                                                          |
| Agents (3)      | The constellation of departments and specialists. Click any node to see its skills and track record |
| Tasks (4)       | The live task graph: each step, which specialist is doing it, and its status                        |
| Departments (5) | Each department's team and results                                                                  |
| Modules (6)     | Capabilities with honest status. Anything not configured says what is needed                        |
| Memory (7)      | What JARVIS remembers. Search it, teach it, verify lessons, forget items                            |
| System (8)      | Connection, renderer, frame rate, model usage and costs in tokens                                   |
| Activity (9)    | Command history and the tamper-evident audit log                                                    |
| Settings (0)    | Providers, models, voice, permissions, display                                                      |
| Account         | Subscription status, activation, plans                                                              |

Drag to orbit, scroll to zoom. **Esc** returns to Command. Use **Settings → Display** to lower quality or reduce motion.

## 5. Memory and learning

JARVIS remembers your preferences and project facts that you add under **Memory → Teach JARVIS**, and it learns workflow lessons from tasks that succeeded and passed verification. You can view, verify or delete anything. JARVIS never modifies the AI models themselves.

## 6. Subscription

- Monthly: **PKR 4,000**. Yearly: **PKR 40,000**.
- If your subscription ends, JARVIS stops running tasks until you renew. Your files, memory and settings are never deleted.
- JARVIS checks your subscription online regularly and can work offline for a limited time (72 hours by default).
- To move to another PC, use **Account → Deactivate this device** first.

## 7. Privacy

- Keys are encrypted and protected by Windows Credential Manager.
- Web pages and files are treated as untrusted data. Instructions hidden in them cannot change what JARVIS is allowed to do.
- Your data stays on your PC under `%APPDATA%\JARVIS`, except what is sent to the AI and search providers you configured in order to do the task.

## 8. Help

See [Troubleshooting](../setup/TROUBLESHOOTING.md). Logs: `%APPDATA%\JARVIS\logs\core.log`.
