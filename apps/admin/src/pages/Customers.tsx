import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../api';
import { ErrorBox, Page, SearchBar, Status, confirmAction, useLoad } from '../ui';

interface CustomerRow {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: boolean;
  created_at: string;
  subscription_status: string | null;
  plan_code: string | null;
  current_period_end: string | null;
  licenses: number;
}

export function Customers() {
  const [q, setQ] = useState('');
  const { data, error, reload } = useLoad(
    () => api<CustomerRow[]>('GET', `/v1/admin/customers?q=${encodeURIComponent(q)}`),
    [q],
  );
  const [creating, setCreating] = useState(false);
  return (
    <Page
      title="Customers"
      actions={<button onClick={() => setCreating((c) => !c)}>{creating ? 'Close' : 'New customer'}</button>}
    >
      {creating && (
        <NewCustomer
          onDone={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
      <SearchBar onSearch={setQ} placeholder="Search email or name" />
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Subscription</th>
            <th>Plan</th>
            <th>Period end</th>
            <th>Licenses</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((c) => (
            <tr key={c.id} className={c.disabled ? 'muted' : ''}>
              <td>
                <Link to={`/customers/${c.id}`}>{c.email}</Link>
              </td>
              <td>{c.name}</td>
              <td>{c.role}</td>
              <td>{c.subscription_status ? <Status value={c.subscription_status} /> : '—'}</td>
              <td>{c.plan_code ?? '—'}</td>
              <td>{fmtDate(c.current_period_end)}</td>
              <td>{c.licenses}</td>
              <td>{fmtDate(c.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

function NewCustomer({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ email: '', name: '', password: '', role: 'customer' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="panel form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/v1/admin/customers', f);
          onDone();
        } catch (x) {
          setErr((x as Error).message);
        }
      }}
    >
      <label>
        Email
        <input
          type="email"
          required
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
        />
      </label>
      <label>
        Name
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label>
        Initial password
        <input
          type="password"
          minLength={10}
          required
          value={f.password}
          onChange={(e) => setF({ ...f, password: e.target.value })}
        />
      </label>
      <label>
        Role
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option>customer</option>
          <option>support</option>
          <option>admin</option>
        </select>
      </label>
      <ErrorBox error={err} />
      <button type="submit">Create</button>
    </form>
  );
}

interface Detail {
  user: { id: string; email: string; name: string; role: string; disabled: boolean; created_at: string };
  subscriptions: Array<{
    id: string;
    plan_code: string;
    status: string;
    current_period_start: string;
    current_period_end: string;
    provider: string;
  }>;
  licenses: Array<{
    id: string;
    key_last4: string;
    status: string;
    max_devices: number;
    created_at: string;
    revoked_reason: string | null;
  }>;
  devices: Array<{
    id: string;
    name: string;
    platform: string;
    status: string;
    last_seen: string;
    app_version: string;
  }>;
  payments: Array<{
    id: string;
    provider: string;
    provider_payment_id: string;
    amount: number;
    currency: string;
    status: string;
    created_at: string;
    plan_code: string;
  }>;
  audit: Array<{ id: string; ts: string; action: string; actor_type: string; details: unknown }>;
}

export function CustomerDetail() {
  const { id } = useParams();
  const { data, error, reload } = useLoad(() => api<Detail>('GET', `/v1/admin/customers/${id}`), [id]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pay, setPay] = useState({ plan: 'monthly', amount: 4000, reference: '', note: '' });
  const [payErr, setPayErr] = useState<string | null>(null);
  if (!data)
    return (
      <Page title="Customer">
        <ErrorBox error={error} />
      </Page>
    );
  const u = data.user;
  return (
    <Page
      title={u.email}
      actions={
        <>
          <button
            onClick={async () => {
              const r = await api<{ key: string }>('POST', '/v1/admin/licenses', { userId: u.id });
              setNewKey(r.key);
              reload();
            }}
          >
            Issue license
          </button>
          <button
            className="danger"
            onClick={() =>
              confirmAction(`${u.disabled ? 'Enable' : 'Disable'} ${u.email}?`, () =>
                api('POST', `/v1/admin/customers/${u.id}/disable`, { disabled: !u.disabled }),
              ).then(reload)
            }
          >
            {u.disabled ? 'Enable account' : 'Disable account'}
          </button>
        </>
      }
    >
      {newKey && (
        <div className="notice">
          New license key (shown once — give it to the customer): <code>{newKey}</code>
        </div>
      )}
      <p>
        {u.name} · role {u.role} · joined {fmtDate(u.created_at)} {u.disabled && <Status value="suspended" />}
      </p>

      <h2>Record payment</h2>
      <form
        className="panel form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setPayErr(null);
          try {
            await api('POST', '/v1/admin/payments/manual', {
              userId: u.id,
              plan: pay.plan,
              amount: Number(pay.amount),
              reference: pay.reference,
              note: pay.note || undefined,
            });
            setPay({ ...pay, reference: '', note: '' });
            reload();
          } catch (x) {
            setPayErr((x as Error).message);
          }
        }}
      >
        <label>
          Plan
          <select
            value={pay.plan}
            onChange={(e) =>
              setPay({ ...pay, plan: e.target.value, amount: e.target.value === 'yearly' ? 40000 : 4000 })
            }
          >
            <option value="monthly">Monthly (PKR 4,000)</option>
            <option value="yearly">Yearly (PKR 40,000)</option>
          </select>
        </label>
        <label>
          Amount (PKR)
          <input
            type="number"
            value={pay.amount}
            onChange={(e) => setPay({ ...pay, amount: Number(e.target.value) })}
          />
        </label>
        <label>
          Payment reference
          <input
            required
            minLength={3}
            value={pay.reference}
            onChange={(e) => setPay({ ...pay, reference: e.target.value })}
            placeholder="Bank transaction ID"
          />
        </label>
        <label>
          Note
          <input value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} />
        </label>
        <ErrorBox error={payErr} />
        <button type="submit">Confirm payment received</button>
      </form>

      <h2>Subscriptions</h2>
      <SubscriptionTable rows={data.subscriptions} onChange={reload} />
      <h2>Licenses</h2>
      <LicenseTable
        rows={data.licenses.map((l) => ({ ...l, email: u.email }))}
        onChange={reload}
        onKey={setNewKey}
      />
      <h2>Devices</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Platform</th>
            <th>Version</th>
            <th>Status</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.devices.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>{d.platform}</td>
              <td>{d.app_version}</td>
              <td>
                <Status value={d.status} />
              </td>
              <td>{fmtDate(d.last_seen)}</td>
              <td>
                {d.status === 'active' && (
                  <button
                    onClick={() =>
                      confirmAction(`Deactivate device ${d.name}?`, () =>
                        api('POST', `/v1/admin/devices/${d.id}/deactivate`),
                      ).then(reload)
                    }
                  >
                    Deactivate
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Payments</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Provider</th>
            <th>Reference</th>
            <th>Plan</th>
            <th>Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.payments.map((p) => (
            <tr key={p.id}>
              <td>{fmtDate(p.created_at)}</td>
              <td>{p.provider}</td>
              <td>{p.provider_payment_id}</td>
              <td>{p.plan_code}</td>
              <td>{fmtMoney(p.amount, p.currency)}</td>
              <td>
                <Status value={p.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Audit</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {data.audit.map((a) => (
            <tr key={a.id}>
              <td>{fmtDate(a.ts)}</td>
              <td>{a.actor_type}</td>
              <td>{a.action}</td>
              <td>
                <code>{JSON.stringify(a.details)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

export function SubscriptionTable({
  rows,
  onChange,
  showEmail,
}: {
  rows: Array<{
    id: string;
    plan_code: string;
    status: string;
    current_period_start: string;
    current_period_end: string;
    provider: string;
    email?: string;
  }>;
  onChange: () => void;
  showEmail?: boolean;
}) {
  const act = (id: string, action: string, needsReason = true) =>
    confirmAction(
      `${action} this subscription?`,
      (reason) => api('POST', `/v1/admin/subscriptions/${id}/${action}`, { reason }),
      needsReason,
    ).then(onChange);
  return (
    <table>
      <thead>
        <tr>
          {showEmail && <th>Customer</th>}
          <th>Plan</th>
          <th>Status</th>
          <th>Period</th>
          <th>Provider</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id}>
            {showEmail && <td>{s.email}</td>}
            <td>{s.plan_code}</td>
            <td>
              <Status value={s.status} />
            </td>
            <td>
              {fmtDate(s.current_period_start)} → {fmtDate(s.current_period_end)}
            </td>
            <td>{s.provider}</td>
            <td className="row-actions">
              {s.status !== 'suspended' && <button onClick={() => act(s.id, 'suspend')}>Suspend</button>}
              {(s.status === 'suspended' || s.status === 'canceled' || s.status === 'expired') && (
                <button onClick={() => act(s.id, 'reactivate', false)}>Reactivate</button>
              )}
              <button
                onClick={() => {
                  const d = Number(window.prompt('Extend by how many days?', '30'));
                  if (d > 0)
                    void confirmAction(
                      `Extend by ${d} days?`,
                      (reason) => api('POST', `/v1/admin/subscriptions/${s.id}/extend`, { days: d, reason }),
                      true,
                    ).then(onChange);
                }}
              >
                Extend
              </button>
              {s.status === 'active' && <button onClick={() => act(s.id, 'cancel')}>Cancel</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LicenseTable({
  rows,
  onChange,
  onKey,
}: {
  rows: Array<{
    id: string;
    key_last4: string;
    status: string;
    max_devices: number;
    created_at: string;
    revoked_reason: string | null;
    email?: string;
    active_devices?: number;
  }>;
  onChange: () => void;
  onKey?: (k: string) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>Key</th>
          <th>Status</th>
          <th>Devices</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.id}>
            <td>{l.email}</td>
            <td>
              <code>JRV-…{l.key_last4}</code>
            </td>
            <td>
              <Status value={l.status} />
              {l.revoked_reason && <small> ({l.revoked_reason})</small>}
            </td>
            <td>
              {l.active_devices !== undefined ? `${l.active_devices} / ` : ''}
              {l.max_devices}
            </td>
            <td>{fmtDate(l.created_at)}</td>
            <td className="row-actions">
              {l.status === 'active' ? (
                <button
                  className="danger"
                  onClick={() =>
                    confirmAction(
                      'Revoke this license? Devices lose access at their next check.',
                      (reason) => api('POST', `/v1/admin/licenses/${l.id}/revoke`, { reason }),
                      true,
                    ).then(onChange)
                  }
                >
                  Revoke
                </button>
              ) : (
                <button
                  onClick={() =>
                    confirmAction('Reactivate this license?', () =>
                      api('POST', `/v1/admin/licenses/${l.id}/reactivate`),
                    ).then(onChange)
                  }
                >
                  Reactivate
                </button>
              )}
              <button
                onClick={() =>
                  confirmAction('Rotate key? The old key stops working immediately.', async () => {
                    const r = await api<{ key: string }>('POST', `/v1/admin/licenses/${l.id}/rotate`);
                    if (onKey) onKey(r.key);
                    else window.alert(`New key: ${r.key}`);
                  }).then(onChange)
                }
              >
                Rotate key
              </button>
              <button
                onClick={() => {
                  const n = Number(window.prompt('Max devices', String(l.max_devices)));
                  if (n > 0)
                    void api('POST', `/v1/admin/licenses/${l.id}/max-devices`, { maxDevices: n }).then(
                      onChange,
                    );
                }}
              >
                Device limit
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
