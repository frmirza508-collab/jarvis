import type { Queryable } from './db.js';
import { redact } from '@jarvis/security';

export interface AuditInput {
  actorType: 'admin' | 'customer' | 'system' | 'device' | 'provider';
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  ip?: string;
  details?: Record<string, unknown>;
}

export async function audit(db: Queryable, a: AuditInput): Promise<void> {
  await db.query(
    'INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, ip, details) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [a.actorType, a.actorId ?? null, a.action, a.targetType ?? null, a.targetId ?? null, a.ip ?? null, JSON.stringify(redact(a.details ?? {}))],
  );
}
