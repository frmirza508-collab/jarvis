import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Locate a Chromium for tests: JARVIS_BROWSER_PATH, then Playwright's cache. */
export function findChromium(): string | undefined {
  if (process.env.JARVIS_BROWSER_PATH && existsSync(process.env.JARVIS_BROWSER_PATH))
    return process.env.JARVIS_BROWSER_PATH;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/opt/pw-browsers',
    path.join(home, '.cache', 'ms-playwright'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : undefined,
  ].filter((r): r is string => !!r && existsSync(r));
  for (const root of roots) {
    for (const d of readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()) {
      for (const rel of [
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
        'chrome-win/chrome.exe',
        'chrome-win64/chrome.exe',
      ]) {
        const p = path.join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}
