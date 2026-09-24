import { api, fmtDate, fmtMoney } from '../api';
import { ErrorBox, Page, useLoad } from '../ui';

interface Dash {
  subscriptions: Array<{ status: string; n: number }>;
  revenue30d: Array<{ currency: string; total: string; n: number }>;
  activeDevices: number;
  customers: number;
  recentActivity: Array<{ ts: string; actor_type: string; action: string; target_type: string | null; target_id: string | null }>;
}

export function Dashboard() {
  const { data, error } = useLoad(() => api<Dash>('GET', '/v1/admin/dashboard'));
  const count = (s: string) => data?.subscriptions.find((x) => x.status === s)?.n ?? 0;
  return (
    <Page title="Dashboard">
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="cards">
            <div className="card"><span>Customers</span><strong>{data.customers}</strong></div>
            <div className="card"><span>Active subscriptions</span><strong>{count('active')}</strong></div>
            <div className="card"><span>Past due</span><strong>{count('past_due')}</strong></div>
            <div className="card"><span>Expired</span><strong>{count('expired')}</strong></div>
            <div className="card"><span>Suspended</span><strong>{count('suspended')}</strong></div>
            <div className="card"><span>Active devices</span><strong>{data.activeDevices}</strong></div>
            {data.revenue30d.map((r) => (
              <div className="card" key={r.currency}><span>Revenue (30 days)</span><strong>{fmtMoney(Number(r.total), r.currency)}</strong><small>{r.n} payments</small></div>
            ))}
          </div>
          <h2>Recent activity</h2>
          <table>
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>
              {data.recentActivity.map((a, i) => (
                <tr key={i}><td>{fmtDate(a.ts)}</td><td>{a.actor_type}</td><td>{a.action}</td><td>{a.target_type ? `${a.target_type}:${a.target_id?.slice(0, 8)}` : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Page>
  );
}
