/** Permission categories every tool/agent/module must declare. */
export const PERMISSION_CATEGORIES = [
  'READ',
  'WRITE',
  'EXECUTE',
  'NETWORK',
  'BROWSER',
  'SYSTEM',
  'SENSITIVE',
  'DESTRUCTIVE',
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/** Risk levels drive whether an action needs explicit confirmation. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const CATEGORY_DEFAULT_RISK: Record<PermissionCategory, RiskLevel> = {
  READ: 'low',
  NETWORK: 'medium',
  BROWSER: 'medium',
  WRITE: 'medium',
  EXECUTE: 'high',
  SYSTEM: 'high',
  SENSITIVE: 'high',
  DESTRUCTIVE: 'critical',
};

const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export function maxRisk(...levels: RiskLevel[]): RiskLevel {
  let idx = 0;
  for (const l of levels) idx = Math.max(idx, RISK_ORDER.indexOf(l));
  return RISK_ORDER[idx] ?? 'low';
}

export function riskAtLeast(level: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_ORDER.indexOf(level) >= RISK_ORDER.indexOf(threshold);
}
