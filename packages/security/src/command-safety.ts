import type { RiskLevel } from '@jarvis/shared';

export interface CommandAssessment {
  risk: RiskLevel;
  reasons: string[];
  /** Blocked commands are never executed, even with confirmation. */
  blocked: boolean;
}

interface Rule {
  re: RegExp;
  risk: RiskLevel;
  reason: string;
  block?: boolean;
}

const RULES: Rule[] = [
  // Catastrophic / never allowed
  {
    re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\*|\/\*)(\s|$)/i,
    risk: 'critical',
    reason: 'recursive delete of root/home',
    block: true,
  },
  { re: /\bformat(\.com)?\s+[a-z]:/i, risk: 'critical', reason: 'disk format', block: true },
  { re: /\b(mkfs|diskpart)\b/i, risk: 'critical', reason: 'disk partition/format tool', block: true },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, risk: 'critical', reason: 'fork bomb', block: true },
  {
    re: /\bvssadmin\b.*\bdelete\s+shadows\b/i,
    risk: 'critical',
    reason: 'shadow copy deletion',
    block: true,
  },
  { re: /\bbcdedit\b/i, risk: 'critical', reason: 'boot configuration change', block: true },
  { re: /\bcipher\s+\/w/i, risk: 'critical', reason: 'free-space wipe', block: true },
  {
    re: /\b(mimikatz|sekurlsa|lsadump)\b/i,
    risk: 'critical',
    reason: 'credential dumping tool',
    block: true,
  },
  {
    re: /\breg(\.exe)?\s+save\s+hklm\\(sam|security|system)\b/i,
    risk: 'critical',
    reason: 'credential hive export',
    block: true,
  },
  {
    re: /Set-MpPreference\b.*-Disable/i,
    risk: 'critical',
    reason: 'disabling Windows Defender',
    block: true,
  },
  {
    re: /\bnetsh\s+advfirewall\s+set\s+\w+\s+state\s+off/i,
    risk: 'critical',
    reason: 'disabling firewall',
    block: true,
  },
  // Destructive, require confirmation
  { re: /\b(rm|rmdir|del|erase|rd)\b/i, risk: 'high', reason: 'file deletion' },
  { re: /\bRemove-Item\b/i, risk: 'high', reason: 'file deletion' },
  {
    re: /\bgit\s+(push\s+.*--force|push\s+-f|reset\s+--hard|clean\s+-[a-z]*f)/i,
    risk: 'high',
    reason: 'destructive git operation',
  },
  { re: /\b(shutdown|restart-computer|stop-computer)\b/i, risk: 'high', reason: 'system power change' },
  {
    re: /\b(reg(\.exe)?\s+(add|delete)|Set-ItemProperty\s+.*HK(LM|CU))/i,
    risk: 'high',
    reason: 'registry modification',
  },
  {
    re: /\b(sc(\.exe)?\s+(delete|config|stop)|Stop-Service|Set-Service)\b/i,
    risk: 'high',
    reason: 'service modification',
  },
  { re: /\b(takeown|icacls|cacls|chmod\s+-R|chown\s+-R)\b/i, risk: 'high', reason: 'permission change' },
  { re: /\b(runas|sudo|Start-Process\b.*-Verb\s+RunAs)\b/i, risk: 'high', reason: 'privilege elevation' },
  {
    re: /(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b.*\|\s*(sh|bash|iex|Invoke-Expression|powershell)/i,
    risk: 'high',
    reason: 'pipe remote script to shell',
  },
  { re: /\b(iex|Invoke-Expression)\b/i, risk: 'high', reason: 'dynamic code execution' },
  { re: /-EncodedCommand|-enc\s+[A-Za-z0-9+/=]{16,}/i, risk: 'high', reason: 'encoded PowerShell command' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, risk: 'high', reason: 'package publication' },
  { re: /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\b/i, risk: 'high', reason: 'database destruction' },
  // Medium: writes/network/installs
  {
    re: /\b(npm|pnpm|yarn|pip|winget|choco|cargo)\s+(install|add|i)\b/i,
    risk: 'medium',
    reason: 'package installation',
  },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr)\b/i, risk: 'medium', reason: 'network download' },
  {
    re: /\b(mv|move|Move-Item|cp|copy|Copy-Item|xcopy|robocopy)\b/i,
    risk: 'medium',
    reason: 'file move/copy',
  },
  { re: /(^|[^>])>{1,2}\s*[^&\s]/, risk: 'medium', reason: 'output redirection writes a file' },
  { re: /\bgit\s+(commit|push|merge|rebase|checkout)\b/i, risk: 'medium', reason: 'git state change' },
];

const ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export function assessCommand(command: string): CommandAssessment {
  let risk: RiskLevel = 'low';
  const reasons: string[] = [];
  let blocked = false;
  for (const rule of RULES) {
    if (rule.re.test(command)) {
      reasons.push(rule.reason);
      if (ORDER.indexOf(rule.risk) > ORDER.indexOf(risk)) risk = rule.risk;
      if (rule.block) blocked = true;
    }
  }
  return { risk, reasons, blocked };
}
