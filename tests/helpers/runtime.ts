import { AuditLog } from '@jarvis/audit';
import { DEFAULT_POLICY, PermissionManager, type ConfirmHandler } from '@jarvis/permissions';
import { ToolRuntime } from '@jarvis/tool-runtime';

export function makeRuntime(confirm: ConfirmHandler = async () => 'allow_once') {
  const audit = new AuditLog();
  const permissions = new PermissionManager(structuredClone(DEFAULT_POLICY), audit, confirm);
  const tools = new ToolRuntime(permissions, audit);
  return { audit, permissions, tools };
}
