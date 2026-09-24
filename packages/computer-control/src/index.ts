import { z } from 'zod';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { JarvisError } from '@jarvis/shared';
import { defineTool, type ToolDefinition } from '@jarvis/tool-runtime';

/**
 * Windows computer control implemented with Windows PowerShell 5.1 (present on
 * every supported Windows 10/11 install) using .NET System.Windows.Forms,
 * System.Drawing, UI Automation and user32 P/Invoke. Parameters are passed as
 * base64-encoded JSON so user text can never be interpreted as script.
 */
export interface ComputerDriver {
  readonly platformSupported: boolean;
  run<T = unknown>(script: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

const PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$P = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:JARVIS_PARAMS)) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ('JarvisUser32' -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class JarvisUser32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
}
function Out-Json($o) { $o | ConvertTo-Json -Depth 6 -Compress }
`;

export class PowerShellDriver implements ComputerDriver {
  readonly platformSupported = process.platform === 'win32';

  run<T = unknown>(script: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.platformSupported) {
      return Promise.reject(new JarvisError('UNSUPPORTED_PLATFORM', 'Computer control is only available on Windows'));
    }
    const full = PRELUDE + script;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        env: { ...process.env, JARVIS_PARAMS: Buffer.from(JSON.stringify(params)).toString('base64') },
      });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (errOut += d.toString('utf8')));
      const t = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', (e) => {
        clearTimeout(t);
        reject(new JarvisError('INTERNAL', e.message));
      });
      child.on('close', (code) => {
        clearTimeout(t);
        if (code !== 0) return reject(new JarvisError('INTERNAL', errOut.trim() || `PowerShell exited ${code}`));
        const text = out.trim();
        try {
          resolve((text ? JSON.parse(text) : null) as T);
        } catch {
          resolve(text as T);
        }
      });
    });
  }
}

/** Escape text for SendKeys so it is typed literally. */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
}

export const SCRIPTS = {
  screenshot: `
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$dir = Split-Path -Parent $P.path
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($P.path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Out-Json @{ path = $P.path; width = $b.Width; height = $b.Height }
`,
  listWindows: `
$w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { @{ pid = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle } }
Out-Json @($w)
`,
  windowAction: `
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ( ($P.pid -and $_.Id -eq $P.pid) -or ($P.title -and $_.MainWindowTitle -like "*$($P.title)*") ) } | Select-Object -First 1
if (-not $proc) { throw "Window not found" }
$h = $proc.MainWindowHandle
switch ($P.action) {
  'focus' { [JarvisUser32]::ShowWindow($h, 9) | Out-Null; [JarvisUser32]::SetForegroundWindow($h) | Out-Null }
  'minimize' { [JarvisUser32]::ShowWindow($h, 6) | Out-Null }
  'maximize' { [JarvisUser32]::ShowWindow($h, 3) | Out-Null }
  'restore' { [JarvisUser32]::ShowWindow($h, 9) | Out-Null }
  'close' { $proc.CloseMainWindow() | Out-Null }
}
Out-Json @{ pid = $proc.Id; title = $proc.MainWindowTitle; action = $P.action }
`,
  launch: `
$args2 = @()
if ($P.args) { $args2 = @($P.args) }
if ($args2.Count -gt 0) { $p = Start-Process -FilePath $P.target -ArgumentList $args2 -PassThru } else { $p = Start-Process -FilePath $P.target -PassThru }
Out-Json @{ pid = $p.Id; target = $P.target }
`,
  clipboardGet: `Out-Json @{ text = (Get-Clipboard -Raw) }`,
  clipboardSet: `Set-Clipboard -Value $P.text; Out-Json @{ ok = $true }`,
  mouse: `
[JarvisUser32]::SetCursorPos([int]$P.x, [int]$P.y) | Out-Null
$down = 0x0002; $up = 0x0004
if ($P.button -eq 'right') { $down = 0x0008; $up = 0x0010 }
for ($i = 0; $i -lt [int]$P.clicks; $i++) { [JarvisUser32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [JarvisUser32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
Out-Json @{ x = $P.x; y = $P.y; clicks = $P.clicks }
`,
  keys: `
[System.Windows.Forms.SendKeys]::SendWait($P.keys)
Out-Json @{ ok = $true }
`,
  inspect: `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([JarvisUser32]::GetForegroundWindow())
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$out = @()
$max = [Math]::Min($all.Count, [int]$P.limit)
for ($i = 0; $i -lt $max; $i++) {
  $e = $all.Item($i).Current
  if (-not $e.IsOffscreen) {
    $r = $e.BoundingRectangle
    $out += @{ name = $e.Name; type = $e.ControlType.ProgrammaticName; automationId = $e.AutomationId; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; enabled = $e.IsEnabled }
  }
}
Out-Json @{ window = $root.Current.Name; elements = $out }
`,
  screenInfo: `
$s = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ name = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } }
Out-Json @($s)
`,
} as const;

export function computerTools(driver: ComputerDriver): ToolDefinition[] {
  const status = () => (driver.platformSupported ? 'active' : 'unsupported') as 'active' | 'unsupported';
  const statusReason = () => (driver.platformSupported ? undefined : 'Requires Windows');
  const base = { module: 'computer-control', status, statusReason };
  return [
    defineTool({
      ...base,
      id: 'computer.screenshot',
      title: 'Screenshot',
      description: 'Capture all screens to a PNG file.',
      categories: ['SYSTEM', 'SENSITIVE'],
      input: z.object({ path: z.string().optional() }),
      assess: () => ({ risk: 'high', description: 'Capture the screen (may include private information)' }),
      execute: (i) => driver.run(SCRIPTS.screenshot, { path: path.resolve(i.path ?? path.join(os.homedir(), 'Pictures', 'JARVIS', `screen-${Date.now()}.png`)) }),
    }),
    defineTool({
      ...base,
      id: 'computer.screens',
      title: 'Screen info',
      description: 'List monitors and their bounds.',
      categories: ['READ'],
      input: z.object({}),
      execute: () => driver.run(SCRIPTS.screenInfo),
    }),
    defineTool({
      ...base,
      id: 'computer.windows',
      title: 'List windows',
      description: 'List open application windows.',
      categories: ['READ', 'SYSTEM'],
      input: z.object({}),
      assess: () => ({ risk: 'medium' }),
      execute: () => driver.run(SCRIPTS.listWindows),
    }),
    defineTool({
      ...base,
      id: 'computer.window',
      title: 'Window action',
      description: 'Focus, minimize, maximize, restore or close a window by title fragment or pid.',
      categories: ['SYSTEM'],
      input: z.object({ action: z.enum(['focus', 'minimize', 'maximize', 'restore', 'close']), title: z.string().optional(), pid: z.number().int().optional() }),
      assess: (i) => ({ risk: i.action === 'close' ? 'high' : 'medium', target: i.title ?? String(i.pid), description: `${i.action} window ${i.title ?? i.pid}` }),
      execute: (i) => {
        if (!i.title && !i.pid) throw new JarvisError('INVALID_INPUT', 'title or pid required');
        return driver.run(SCRIPTS.windowAction, i);
      },
    }),
    defineTool({
      ...base,
      id: 'computer.launch',
      title: 'Launch application',
      description: 'Start an application, document or URL with its default handler.',
      categories: ['EXECUTE', 'SYSTEM'],
      input: z.object({ target: z.string().min(1), args: z.array(z.string()).optional() }),
      assess: (i) => ({ risk: 'high', target: i.target, description: `Launch ${i.target} ${(i.args ?? []).join(' ')}` }),
      execute: (i) => driver.run(SCRIPTS.launch, i),
    }),
    defineTool({
      ...base,
      id: 'computer.clipboard_read',
      title: 'Read clipboard',
      description: 'Read text from the clipboard.',
      categories: ['SENSITIVE'],
      input: z.object({}),
      assess: () => ({ risk: 'high', description: 'Read clipboard contents' }),
      execute: () => driver.run(SCRIPTS.clipboardGet),
    }),
    defineTool({
      ...base,
      id: 'computer.clipboard_write',
      title: 'Write clipboard',
      description: 'Put text on the clipboard.',
      categories: ['SYSTEM'],
      input: z.object({ text: z.string().max(1_000_000) }),
      assess: () => ({ risk: 'medium' }),
      execute: (i) => driver.run(SCRIPTS.clipboardSet, i),
    }),
    defineTool({
      ...base,
      id: 'computer.mouse',
      title: 'Mouse click',
      description: 'Move the mouse to screen coordinates and click.',
      categories: ['SYSTEM'],
      input: z.object({ x: z.number().int(), y: z.number().int(), button: z.enum(['left', 'right']).default('left'), clicks: z.number().int().min(0).max(3).default(1) }),
      assess: (i) => ({ risk: 'high', description: `${i.button} click x${i.clicks} at (${i.x}, ${i.y})` }),
      execute: (i) => driver.run(SCRIPTS.mouse, i),
    }),
    defineTool({
      ...base,
      id: 'computer.type',
      title: 'Type text',
      description: 'Type literal text into the focused window.',
      categories: ['SYSTEM'],
      input: z.object({ text: z.string().max(10_000) }),
      assess: (i) => ({ risk: 'high', description: `Type ${i.text.length} characters into the focused window` }),
      execute: (i) => driver.run(SCRIPTS.keys, { keys: escapeSendKeys(i.text) }),
    }),
    defineTool({
      ...base,
      id: 'computer.hotkey',
      title: 'Press keys',
      description: 'Press a key combination using SendKeys syntax, e.g. "^s" (Ctrl+S), "%{F4}" (Alt+F4), "{ENTER}".',
      categories: ['SYSTEM'],
      input: z.object({ keys: z.string().min(1).max(200) }),
      assess: (i) => ({ risk: /%\{F4\}|\^\{ESC\}/i.test(i.keys) ? 'high' : 'medium', description: `Press ${i.keys}` }),
      execute: (i) => driver.run(SCRIPTS.keys, i),
    }),
    defineTool({
      ...base,
      id: 'computer.inspect',
      title: 'Inspect UI elements',
      description: 'List visible UI Automation elements (name, type, bounds) of the foreground window.',
      categories: ['READ', 'SYSTEM'],
      input: z.object({ limit: z.number().int().min(1).max(1000).default(200) }),
      assess: () => ({ risk: 'medium' }),
      execute: (i) => driver.run(SCRIPTS.inspect, i, 60_000),
    }),
  ] as ToolDefinition[];
}
