import { useEffect, useState } from 'react';
import { core } from '../lib/actions';
import { useStore } from '../lib/store';
import { Glass, StateBadge } from '../components/Glass';
import type { AuditEntry, HistoryItem } from '../lib/types';

export function ActivityPanel() {
  const liveAudit = useStore((s) => s.audit);
  const [audit, setAudit] = useState<{ chainIntact: boolean; entries: AuditEntry[] } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  useEffect(() => {
    void core().get<{ chainIntact: boolean; entries: AuditEntry[] }>('/audit?limit=300').then(setAudit);
    void core().get<HistoryItem[]>('/history').then(setHistory);
  }, [liveAudit.length]);
  return (
    <>
      <Glass title="Command history" className="side-left" tilt="left">
        <ul className="history">
          {history.map((h) => (
            <li key={h.id}><StateBadge state={h.status} /> <b dir="auto">{h.request}</b><br /><small>{new Date(h.startedAt).toLocaleString()} · {h.agents.length} agents</small><p dir="auto">{h.summary.slice(0, 240)}</p></li>
          ))}
        </ul>
      </Glass>
      <Glass title="Audit log" className="side-right" tilt="right" actions={audit && <StateBadge state={audit.chainIntact ? 'chain_intact' : 'chain_broken'} />}>
        <table className="dense">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead>
          <tbody>
            {audit?.entries.slice().reverse().map((e) => (
              <tr key={e.id}><td>{new Date(e.ts).toLocaleTimeString()}</td><td>{e.actor}</td><td>{e.action}</td><td className="ellipsis" title={e.target}>{e.target ?? ''}</td><td><StateBadge state={e.outcome} /></td></tr>
            ))}
          </tbody>
        </table>
      </Glass>
    </>
  );
}
