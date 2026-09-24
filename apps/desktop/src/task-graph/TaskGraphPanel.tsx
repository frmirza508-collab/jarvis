import { cancelRequest } from '../lib/actions';
import { useStore } from '../lib/store';
import { Empty, Glass, StateBadge } from '../components/Glass';

export function TaskGraphPanel() {
  const live = useStore((s) => s.live);
  const messages = useStore((s) => s.messages);
  const agents = useStore((s) => s.agents);
  const reqs = Object.values(live);
  const last = [...messages].reverse().find((m) => m.result?.plan);
  return (
    <Glass title="Live task graph" className="side-right" tilt="right">
      {reqs.length === 0 && !last && (
        <Empty>No task running. Give JARVIS a multi-step goal to see the plan execute here.</Empty>
      )}
      {reqs.map((r) => (
        <div key={r.id} className="req">
          <h3>{r.text}</h3>
          <button className="link small" onClick={() => void cancelRequest(r.id)}>
            Cancel
          </button>
          <table className="dense">
            <thead>
              <tr>
                <th>Step</th>
                <th>Specialist</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(r.nodes).map((n) => (
                <tr key={n.id}>
                  <td>{n.label}</td>
                  <td>{n.assignee ? (agents[n.assignee]?.name ?? n.assignee) : '—'}</td>
                  <td>
                    <StateBadge state={n.status} />
                    {n.error && <small className="warn"> {n.error}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="timeline">
            {r.progress.slice(-12).map((p, i) => (
              <div key={i}>
                <time>{new Date(p.ts).toLocaleTimeString()}</time> <b>{agents[p.from]?.name ?? p.from}</b>{' '}
                {p.message}
              </div>
            ))}
          </div>
        </div>
      ))}
      {reqs.length === 0 && last?.result?.plan && (
        <div className="req done">
          <h3>Last plan ({last.result.plan.mode})</h3>
          <ol>
            {last.result.plan.tasks.map((t) => (
              <li key={t.id}>
                <b>{agents[t.agent]?.name ?? t.agent}</b>: {t.goal}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Glass>
  );
}
