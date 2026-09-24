import { describe, expect, it, vi } from 'vitest';
import { AuditLog } from '@jarvis/audit';
import { DEFAULT_POLICY, PermissionManager } from '../src/index.js';

const mk = (confirm?: () => Promise<'allow_once' | 'allow_always' | 'deny'>) => new PermissionManager(structuredClone(DEFAULT_POLICY), new AuditLog(), confirm);

describe('permission manager', () => {
  it('auto-allows low-risk READ without prompting', async () => {
    const confirm = vi.fn();
    const pm = mk(confirm);
    expect((await pm.request({ actor: 'a', action: 'fs.read', categories: ['READ'], description: 'read' })).allowed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('denies protected actions when no UI handler is attached', async () => {
    const r = await mk().request({ actor: 'a', action: 'shell.run', categories: ['EXECUTE'], description: 'x' });
    expect(r).toMatchObject({ allowed: false, decidedBy: 'no-handler' });
  });
  it('asks the user and honours deny', async () => {
    const pm = mk(async () => 'deny');
    expect((await pm.request({ actor: 'a', action: 'fs.write', categories: ['WRITE'], description: 'x' })).allowed).toBe(false);
  });
  it('allow_always creates a rule used next time', async () => {
    const confirm = vi.fn(async () => 'allow_always' as const);
    const pm = mk(confirm);
    await pm.request({ actor: 'a', action: 'shell.run', categories: ['EXECUTE'], description: 'x', target: 'C:\\proj' });
    const second = await pm.request({ actor: 'a', action: 'shell.run', categories: ['EXECUTE'], description: 'y', target: 'C:\\proj\\sub' });
    expect(second).toMatchObject({ allowed: true, decidedBy: 'rule' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it('always confirms critical destructive actions even with an allow rule', async () => {
    const confirm = vi.fn(async () => 'allow_once' as const);
    const pm = mk(confirm);
    pm.addRule({ action: 'fs.*', effect: 'allow', maxRisk: 'critical' });
    await pm.request({ actor: 'a', action: 'fs.delete', categories: ['DESTRUCTIVE'], description: 'rm' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it('deny rules win', async () => {
    const pm = mk(async () => 'allow_once');
    pm.addRule({ action: 'browser.*', effect: 'deny', maxRisk: 'low' });
    expect((await pm.request({ actor: 'a', action: 'browser.open', categories: ['READ'], description: 'x' })).allowed).toBe(false);
  });
});
