import { CoreClient, isTauri, resolveConnection, type CoreError } from './core-client';
import {
  applyLiveMessage,
  applyServerMessage,
  getState,
  notify,
  setState,
  takeEarly,
  type ViewId,
} from './store';
import type { AgentInfo, CoreStatus, LicenseStatus, ServerMessage } from './types';

let client: CoreClient | undefined;
export const core = (): CoreClient => {
  if (!client) throw new Error('Not connected to JARVIS core');
  return client;
};

export async function refreshStatus(): Promise<void> {
  const status = await core().get<CoreStatus>('/status');
  setState({ status, license: status.license });
}

export async function refreshAgents(): Promise<void> {
  const list = await core().get<AgentInfo[]>('/agents');
  setState({ agents: Object.fromEntries(list.map((a) => [a.id, a])) });
}

export async function connect(): Promise<void> {
  setState({ connection: 'connecting', connectionError: undefined });
  try {
    const conn = await resolveConnection();
    client = new CoreClient(conn, isTauri() ? resolveConnection : undefined);
    await client.get('/status');
    client.onMessage((m) => {
      const k = (m as { kind: string }).kind;
      if (k === 'graph' || k === 'delta')
        applyLiveMessage(m as unknown as Parameters<typeof applyLiveMessage>[0]);
      else applyServerMessage(m as ServerMessage);
    });
    client.onConnection((c) => {
      setState({ connection: c ? 'connected' : 'disconnected' });
      // After a reconnect (possibly to a restarted core) resync state.
      if (c) void Promise.all([refreshStatus(), refreshAgents()]).catch(() => {});
    });
    client.connect();
    await Promise.all([refreshStatus(), refreshAgents()]);
    setState({ connection: 'connected' });
    setInterval(() => void refreshStatus().catch(() => {}), 15_000);
  } catch (e) {
    setState({ connection: 'error', connectionError: (e as Error).message });
  }
}

let msgSeq = 0;
export async function sendRequest(text: string, language?: string): Promise<string | undefined> {
  const t = text.trim();
  if (!t) return;
  const userMsg = { id: `m${++msgSeq}`, role: 'user' as const, text: t, ts: Date.now(), language };
  setState((s) => ({ messages: [...s.messages, userMsg] }));
  try {
    const { requestId } = await core().post<{ requestId: string }>('/requests', {
      text: t,
      language,
      sessionId: sessionId(),
    });
    setState((s) => ({
      messages: [
        ...s.messages,
        { id: `m${++msgSeq}`, role: 'jarvis', text: '…', requestId, status: 'pending', ts: Date.now() },
      ],
      live: {
        ...s.live,
        [requestId]: { id: requestId, text: t, nodes: {}, progress: [], agents: [], startedAt: Date.now() },
      },
    }));
    const early = takeEarly(requestId);
    if (early) applyServerMessage(early);
    return requestId;
  } catch (e) {
    const err = e as CoreError;
    const text2 = err.status === 402 ? `${err.message} Open Account to activate or renew.` : err.message;
    setState((s) => ({
      messages: [
        ...s.messages,
        { id: `m${++msgSeq}`, role: 'system', text: text2, status: 'error', ts: Date.now() },
      ],
    }));
    if (err.status === 402) notify('warning', 'Subscription required for task execution');
    return undefined;
  }
}

let sid: string | undefined;
function sessionId(): string {
  if (!sid) sid = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return sid;
}

export async function cancelRequest(requestId: string): Promise<void> {
  await core().post(`/requests/${requestId}/cancel`);
}

export async function decidePermission(
  id: string,
  decision: 'allow_once' | 'allow_always' | 'deny',
): Promise<void> {
  await core().post(`/permissions/${id}/decision`, { decision });
  setState((s) => ({ permissions: s.permissions.filter((p) => p.id !== id) }));
}

export function go(view: ViewId, extra: { agent?: string; department?: string } = {}): void {
  setState({
    view,
    selectedAgent: extra.agent ?? getState().selectedAgent,
    selectedDepartment: extra.department ?? getState().selectedDepartment,
  });
}

export async function activateLicense(key: string): Promise<LicenseStatus> {
  const s = await core().post<LicenseStatus>('/license/activate', { licenseKey: key });
  setState({ license: s });
  return s;
}

export async function refreshLicense(): Promise<void> {
  try {
    setState({ license: await core().post<LicenseStatus>('/license/refresh') });
  } catch (e) {
    notify('error', (e as Error).message);
    setState({ license: await core().get<LicenseStatus>('/license') });
  }
}

export async function deactivateLicense(): Promise<void> {
  setState({ license: await core().post<LicenseStatus>('/license/deactivate') });
}
