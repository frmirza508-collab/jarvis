import { JarvisError } from '@jarvis/shared';
import type { Queryable } from '../db.js';
import { hashPassword, newSessionToken, sha256, verifyPassword } from '../crypto.js';
import { audit } from '../audit.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'customer' | 'support' | 'admin';
  disabled: boolean;
  created_at: Date;
}

export async function createUser(db: Queryable, input: { email: string; password: string; name?: string; role?: UserRow['role'] }): Promise<UserRow> {
  if (input.password.length < 10) throw new JarvisError('INVALID_INPUT', 'Password must be at least 10 characters');
  const hash = await hashPassword(input.password);
  try {
    const r = await db.query<UserRow>('INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role, disabled, created_at', [input.email.toLowerCase(), input.name ?? '', hash, input.role ?? 'customer']);
    await audit(db, { actorType: 'system', action: 'user.create', targetType: 'user', targetId: r.rows[0]!.id, details: { role: input.role ?? 'customer' } });
    return r.rows[0]!;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new JarvisError('INVALID_INPUT', 'An account with this email already exists');
    throw e;
  }
}

const SESSION_HOURS = 12;

export async function login(db: Queryable, email: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; user: UserRow }> {
  const r = await db.query<UserRow & { password_hash: string }>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const u = r.rows[0];
  // Constant-ish time: always run a verification.
  const ok = await verifyPassword(password, u?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  if (!u || !ok || u.disabled) {
    await audit(db, { actorType: 'customer', action: 'auth.login_failed', ip: meta.ip, details: { email } });
    throw new JarvisError('PERMISSION_DENIED', 'Invalid email or password');
  }
  const token = newSessionToken();
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours', $3, $4)`, [u.id, sha256(token), meta.ip ?? null, meta.userAgent ?? null]);
  await audit(db, { actorType: u.role === 'customer' ? 'customer' : 'admin', actorId: u.id, action: 'auth.login', ip: meta.ip });
  const { password_hash: _ph, ...user } = u;
  return { token, user };
}

export async function userForToken(db: Queryable, token: string): Promise<UserRow | undefined> {
  const r = await db.query<UserRow>(
    'SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled',
    [sha256(token)],
  );
  return r.rows[0];
}

export async function logout(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
