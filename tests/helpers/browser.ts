import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Locate a Chromium for tests: JARVIS_BROWSER_PATH, then Playwright's cache. */
export function findChromium(): string | undefined {
  if (process.env.JARVIS_BROWSER_PATH && existsSync(process.env.JARVIS_BROWSER_PATH)) return process.env.JARVIS_BROWSER_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}
