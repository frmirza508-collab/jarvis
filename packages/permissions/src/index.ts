import {
  CATEGORY_DEFAULT_RISK,
  maxRisk,
  newId,
  riskAtLeast,
  type PermissionCategory,
  type RiskLevel,
} from '@jarvis/shared';
import type { AuditLog } from '@jarvis/audit';

export interface PermissionRequest {
  id: string;
  actor: string; // agent or module id
  action: string; // e.g. "fs.delete"
  categories: PermissionCategory[];
  risk: RiskLevel;
  description: string;
  target?: string;
}

export type Decision = 'allow_once' | 'allow_always' | 'deny';

/** A persistent rule the user created. Scope is matched against action + target prefix. */
export interface PolicyRule {
  id: string;
  action: string; // exact action or prefix ending in "*"
  targetPrefix?: string;
  effect: 'allow' | 'deny';
  /** Rules never auto-allow above this risk level. */
  maxRisk: RiskLevel;
  createdAt: string;
}

export interface PermissionPolicy {
  /** Requests at or above this risk require explicit confirmation. */
  confirmAtOrAbove: RiskLevel;
  /** Categories allowed without prompting (below confirm threshold). */
  autoAllow: PermissionCategory[];
  rules: PolicyRule[];
}

export const DEFAULT_POLICY: PermissionPolicy = {
  confirmAtOrAbove: 'high',
  autoAllow: ['READ', 'NETWORK'],
  rules: [],
};

/** UI callback that asks the human. Must be backed by a real user interaction. */
export type ConfirmHandler = (req: PermissionRequest) => Promise<Decision>;

export interface PermissionCheck {
  allowed: boolean;
  decidedBy: 'policy' | 'rule' | 'user' | 'no-handler';
  requestId: string;
}

function matches(rule: PolicyRule, req: PermissionRequest): boolean {
  const actionOk = rule.action.endsWith('*')
    ? req.action.startsWith(rule.action.slice(0, -1))
    : rule.action === req.action;
  const targetOk =
    !rule.targetPrefix || (req.target ?? '').toLowerCase().startsWith(rule.targetPrefix.toLowerCase());
  return actionOk && targetOk;
}

/**
 * Central permission manager. Only the user (via ConfirmHandler) or rules the
 * user created can allow protected actions. Content from models or web pages
 * cannot call grant APIs: rule creation is only reachable from the UI channel.
 */
export class PermissionManager {
  private pending = new Map<string, PermissionRequest>();

  constructor(
    private policy: PermissionPolicy,
    private readonly audit: AuditLog,
    private confirm?: ConfirmHandler,
  ) {}

  setConfirmHandler(h: ConfirmHandler | undefined): void {
    this.confirm = h;
  }

  getPolicy(): PermissionPolicy {
    return structuredClone(this.policy);
  }

  setPolicy(p: PermissionPolicy): void {
    this.policy = structuredClone(p);
    this.audit.record({ actor: 'user', action: 'permissions.policy.update', outcome: 'info' });
  }

  addRule(rule: Omit<PolicyRule, 'id' | 'createdAt'>): PolicyRule {
    const r: PolicyRule = { ...rule, id: newId('rule'), createdAt: new Date().toISOString() };
    this.policy.rules.push(r);
    this.audit.record({ actor: 'user', action: 'permissions.rule.add', outcome: 'info', details: { ...r } });
    return r;
  }

  removeRule(id: string): boolean {
    const before = this.policy.rules.length;
    this.policy.rules = this.policy.rules.filter((r) => r.id !== id);
    return this.policy.rules.length !== before;
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()];
  }

  static riskFor(categories: PermissionCategory[], extra: RiskLevel = 'low'): RiskLevel {
    return maxRisk(extra, ...categories.map((c) => CATEGORY_DEFAULT_RISK[c]));
  }

  async request(
    input: Omit<PermissionRequest, 'id' | 'risk'> & { risk?: RiskLevel },
  ): Promise<PermissionCheck> {
    const req: PermissionRequest = {
      ...input,
      id: newId('perm'),
      risk: maxRisk(input.risk ?? 'low', PermissionManager.riskFor(input.categories)),
    };
    const log = (allowed: boolean, decidedBy: PermissionCheck['decidedBy']): PermissionCheck => {
      this.audit.record({
        actor: req.actor,
        action: `permission:${req.action}`,
        target: req.target,
        outcome: allowed ? 'allowed' : 'denied',
        details: { categories: req.categories, risk: req.risk, decidedBy, description: req.description },
      });
      return { allowed, decidedBy, requestId: req.id };
    };

    // 1. Explicit user rules (deny wins).
    const hits = this.policy.rules.filter((r) => matches(r, req));
    if (hits.some((r) => r.effect === 'deny')) return log(false, 'rule');
    const allowRule = hits.find((r) => r.effect === 'allow' && riskAtLeast(r.maxRisk, req.risk));
    // DESTRUCTIVE critical actions always confirm, even with rules.
    if (allowRule && req.risk !== 'critical') return log(true, 'rule');

    // 2. Low-risk auto-allowed categories.
    const needsConfirm = riskAtLeast(req.risk, this.policy.confirmAtOrAbove);
    if (!needsConfirm && req.categories.every((c) => this.policy.autoAllow.includes(c)))
      return log(true, 'policy');

    // 3. Ask the user.
    if (!this.confirm) return log(false, 'no-handler');
    this.pending.set(req.id, req);
    try {
      const decision = await this.confirm(req);
      if (decision === 'allow_always' && req.risk !== 'critical') {
        this.addRule({ action: req.action, targetPrefix: req.target, effect: 'allow', maxRisk: req.risk });
      }
      return log(decision !== 'deny', 'user');
    } finally {
      this.pending.delete(req.id);
    }
  }
}
