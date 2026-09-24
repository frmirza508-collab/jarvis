import { useEffect, useState } from 'react';
import { core } from '../lib/actions';
import { useStore } from '../lib/store';
import { Glass, StateBadge } from '../components/Glass';

interface ModelStats {
  stats: Record<
    string,
    {
      requests: number;
      errors: number;
      promptTokens: number;
      completionTokens: number;
      totalLatencyMs: number;
      lastError?: string;
    }
  >;
  log: Array<{
    ts: string;
    role: string;
    provider: string;
    model: string;
    ok: boolean;
    latencyMs: number;
    tokens?: number;
    error?: string;
  }>;
}

interface UpdateInfo {
  current: string;
  latest?: string | null;
  updateAvailable: boolean;
  url?: string;
  sha256?: string;
  notes?: string;
  reason?: string;
}

function Updates() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const check = () =>
    void core()
      .get<UpdateInfo>('/updates')
      .then((i) => {
        setInfo(i);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(check, []);
  return (
    <>
      <h3>Updates</h3>
      {err && <p className="warn">{err}</p>}
      {info && !info.updateAvailable && (
        <p className="hint">
          JARVIS {info.current} is up to date{info.reason ? ` (${info.reason})` : ''}.
        </p>
      )}
      {info?.updateAvailable && (
        <div className="banner warn">
          Version {info.latest} is available. {info.notes}
          <div className="row">
            <button onClick={() => void core().post('/system/open-url', { url: info.url })}>
              Download installer
            </button>
          </div>
          <small>
            Verify SHA-256: <code>{info.sha256}</code>
          </small>
        </div>
      )}
      <button className="small" onClick={check}>
        Check for updates
      </button>
    </>
  );
}

export function SystemPanel() {
  const status = useStore((s) => s.status);
  const fps = useStore((s) => s.fps);
  const renderer = useStore((s) => s.rendererKind);
  const connection = useStore((s) => s.connection);
  const [models, setModels] = useState<ModelStats | null>(null);
  useEffect(() => {
    const load = () =>
      void core()
        .get<ModelStats>('/models/stats')
        .then(setModels)
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <Glass title="System" className="side-left" tilt="left">
        <dl className="kv">
          <dt>Core</dt>
          <dd>
            <StateBadge state={connection} /> v{status?.version}
          </dd>
          <dt>Platform</dt>
          <dd>{status?.platform}</dd>
          <dt>Renderer</dt>
          <dd>
            {renderer ?? '—'} · {fps} FPS
          </dd>
          <dt>Agents</dt>
          <dd>{status?.agents.total}</dd>
          <dt>Active requests</dt>
          <dd>{status?.activeRequests.length ?? 0}</dd>
          <dt>Memory</dt>
          <dd>
            {Object.entries(status?.memory ?? {})
              .map(([k, v]) => `${k}: ${v}`)
              .join(' · ') || 'empty'}
          </dd>
        </dl>
        <Updates />
        <h3>Providers</h3>
        <ul>
          {status?.providers.map((p) => (
            <li key={p.id}>
              {p.id} <StateBadge state={p.configured ? 'active' : 'not_configured'} />
            </li>
          ))}
        </ul>
      </Glass>
      <Glass title="Model usage" className="side-right" tilt="right">
        <table className="dense">
          <thead>
            <tr>
              <th>Model</th>
              <th>Requests</th>
              <th>Errors</th>
              <th>Tokens in/out</th>
              <th>Avg latency</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(models?.stats ?? {}).map(([k, s]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{s.requests}</td>
                <td>{s.errors}</td>
                <td>
                  {s.promptTokens}/{s.completionTokens}
                </td>
                <td>{s.requests ? `${(s.totalLatencyMs / s.requests / 1000).toFixed(1)}s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Recent model calls</h3>
        <div className="timeline">
          {models?.log
            .slice()
            .reverse()
            .slice(0, 20)
            .map((l, i) => (
              <div key={i} className={l.ok ? '' : 'warn'}>
                <time>{new Date(l.ts).toLocaleTimeString()}</time> {l.role} → {l.model}{' '}
                {l.ok ? `${l.latencyMs}ms · ${l.tokens ?? 0} tok` : l.error}
              </div>
            ))}
        </div>
      </Glass>
    </>
  );
}
