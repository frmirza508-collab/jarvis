import { useState } from 'react';
import { api, fmtDate, fmtMoney } from '../api';
import { ErrorBox, Page, SearchBar, Status, confirmAction, useLoad } from '../ui';
import { LicenseTable, SubscriptionTable } from './Customers';

function StatusFilter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Status filter">
      <option value="">All statuses</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export function Subscriptions() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, reload } = useLoad(
    () =>
      api<Parameters<typeof SubscriptionTable>[0]['rows']>(
        'GET',
        `/v1/admin/subscriptions?status=${status}&q=${encodeURIComponent(q)}`,
      ),
    [q, status],
  );
  return (
    <Page title="Subscriptions">
      <SearchBar onSearch={setQ} placeholder="Customer email">
        <StatusFilter
          value={status}
          onChange={setStatus}
          options={['active', 'past_due', 'canceled', 'expired', 'suspended']}
        />
      </SearchBar>
      <ErrorBox error={error} />
      {data && <SubscriptionTable rows={data} onChange={reload} showEmail />}
    </Page>
  );
}

export function Licenses() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, reload } = useLoad(
    () =>
      api<Parameters<typeof LicenseTable>[0]['rows']>(
        'GET',
        `/v1/admin/licenses?status=${status}&q=${encodeURIComponent(q)}`,
      ),
    [q, status],
  );
  return (
    <Page title="Licenses">
      <SearchBar onSearch={setQ} placeholder="Email or last 4 of key">
        <StatusFilter value={status} onChange={setStatus} options={['active', 'revoked']} />
      </SearchBar>
      <ErrorBox error={error} />
      {data && <LicenseTable rows={data} onChange={reload} />}
    </Page>
  );
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  app_version: string;
  status: string;
  first_seen: string;
  last_seen: string;
  last_ip: string | null;
  email: string;
  key_last4: string;
}
export function Devices() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, reload } = useLoad(
    () => api<DeviceRow[]>('GET', `/v1/admin/devices?status=${status}&q=${encodeURIComponent(q)}`),
    [q, status],
  );
  return (
    <Page title="Devices">
      <SearchBar onSearch={setQ} placeholder="Email or device name">
        <StatusFilter value={status} onChange={setStatus} options={['active', 'deactivated']} />
      </SearchBar>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>License</th>
            <th>Device</th>
            <th>Platform</th>
            <th>Version</th>
            <th>Status</th>
            <th>First seen</th>
            <th>Last seen</th>
            <th>IP</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((d) => (
            <tr key={d.id}>
              <td>{d.email}</td>
              <td>
                <code>…{d.key_last4}</code>
              </td>
              <td>{d.name}</td>
              <td>{d.platform}</td>
              <td>{d.app_version}</td>
              <td>
                <Status value={d.status} />
              </td>
              <td>{fmtDate(d.first_seen)}</td>
              <td>{fmtDate(d.last_seen)}</td>
              <td>{d.last_ip ?? '—'}</td>
              <td>
                {d.status === 'active' && (
                  <button
                    onClick={() =>
                      confirmAction(`Deactivate ${d.name}?`, () =>
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
    </Page>
  );
}

interface PaymentRow {
  id: string;
  email: string | null;
  provider: string;
  provider_payment_id: string;
  plan_code: string | null;
  amount: number;
  currency: string;
  status: string;
  note: string | null;
  created_at: string;
}
export function Payments() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { data, error } = useLoad(
    () => api<PaymentRow[]>('GET', `/v1/admin/payments?status=${status}&q=${encodeURIComponent(q)}`),
    [q, status],
  );
  const hooks = useLoad(() =>
    api<
      Array<{
        id: string;
        provider: string;
        provider_event_id: string;
        type: string;
        status: string;
        error: string | null;
        received_at: string;
      }>
    >('GET', '/v1/admin/webhooks'),
  );
  return (
    <Page title="Payments">
      <p className="hint">To record a bank transfer, open the customer and use “Record payment”.</p>
      <SearchBar onSearch={setQ} placeholder="Email or payment reference">
        <StatusFilter value={status} onChange={setStatus} options={['succeeded', 'failed', 'refunded']} />
      </SearchBar>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Customer</th>
            <th>Provider</th>
            <th>Reference</th>
            <th>Plan</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((p) => (
            <tr key={p.id}>
              <td>{fmtDate(p.created_at)}</td>
              <td>{p.email ?? '—'}</td>
              <td>{p.provider}</td>
              <td>{p.provider_payment_id}</td>
              <td>{p.plan_code ?? '—'}</td>
              <td>{fmtMoney(p.amount, p.currency)}</td>
              <td>
                <Status value={p.status} />
              </td>
              <td>{p.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Webhook deliveries</h2>
      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Provider</th>
            <th>Event</th>
            <th>Type</th>
            <th>Status</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {hooks.data?.map((w) => (
            <tr key={w.id}>
              <td>{fmtDate(w.received_at)}</td>
              <td>{w.provider}</td>
              <td>{w.provider_event_id}</td>
              <td>{w.type}</td>
              <td>
                <Status value={w.status} />
              </td>
              <td>{w.error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

interface AuditRow {
  id: string;
  ts: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  details: unknown;
}
export function AuditLog() {
  const [q, setQ] = useState('');
  const { data, error } = useLoad(
    () => api<AuditRow[]>('GET', `/v1/admin/audit?action=${encodeURIComponent(q)}&limit=500`),
    [q],
  );
  return (
    <Page title="Audit log">
      <SearchBar onSearch={setQ} placeholder="Filter by action (e.g. license, subscription.suspend)" />
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>IP</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((a) => (
            <tr key={a.id}>
              <td>{fmtDate(a.ts)}</td>
              <td>
                {a.actor_type}
                {a.actor_id ? `:${a.actor_id.slice(0, 8)}` : ''}
              </td>
              <td>{a.action}</td>
              <td>{a.target_type ? `${a.target_type}:${(a.target_id ?? '').slice(0, 8)}` : '—'}</td>
              <td>{a.ip ?? ''}</td>
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

interface PlanRow {
  code: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
  active: boolean;
  updated_at: string;
}
export function Plans() {
  const { data, error, reload } = useLoad(() => api<PlanRow[]>('GET', '/v1/admin/plans'));
  return (
    <Page title="Plans">
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Price</th>
            <th>Interval</th>
            <th>Active</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((p) => (
            <tr key={p.code}>
              <td>{p.code}</td>
              <td>{p.name}</td>
              <td>{fmtMoney(p.amount, p.currency)}</td>
              <td>{p.interval}</td>
              <td>{p.active ? 'yes' : 'no'}</td>
              <td>{fmtDate(p.updated_at)}</td>
              <td className="row-actions">
                <button
                  onClick={() => {
                    const a = Number(
                      window.prompt(`New price for ${p.name} (${p.currency})`, String(p.amount)),
                    );
                    if (a > 0)
                      void confirmAction(
                        `Change ${p.name} to ${a} ${p.currency}? Applies to new payments only.`,
                        () => api('PUT', `/v1/admin/plans/${p.code}`, { amount: a }),
                      ).then(reload);
                  }}
                >
                  Change price
                </button>
                <button
                  onClick={() =>
                    confirmAction(`${p.active ? 'Hide' : 'Show'} plan ${p.name}?`, () =>
                      api('PUT', `/v1/admin/plans/${p.code}`, { active: !p.active }),
                    ).then(reload)
                  }
                >
                  {p.active ? 'Deactivate' : 'Activate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

interface SettingsData {
  graceHours: number;
  canceledKeepsAccessUntilPeriodEnd: boolean;
  defaultMaxDevices: number;
  tokenTtlHours: number;
  bankTransferInstructions: string;
  latestRelease: { version: string; url: string; sha256: string; notes?: string } | null;
  providers: Array<{ id: string; configured: boolean }>;
}
export function Settings() {
  const { data, error, reload } = useLoad(() => api<SettingsData>('GET', '/v1/admin/settings'));
  const [msg, setMsg] = useState<string | null>(null);
  if (!data)
    return (
      <Page title="Settings">
        <ErrorBox error={error} />
      </Page>
    );
  return (
    <Page title="Settings">
      <form
        className="panel form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            await api('PUT', '/v1/admin/settings', {
              graceHours: Number(f.get('graceHours')),
              canceledKeepsAccessUntilPeriodEnd: f.get('canceledKeeps') === 'on',
              defaultMaxDevices: Number(f.get('defaultMaxDevices')),
              tokenTtlHours: Number(f.get('tokenTtlHours')),
              bankTransferInstructions: String(f.get('bank')),
              latestRelease: f.get('relVersion')
                ? {
                    version: String(f.get('relVersion')),
                    url: String(f.get('relUrl')),
                    sha256: String(f.get('relSha')).toLowerCase(),
                    notes: String(f.get('relNotes') || '') || undefined,
                  }
                : null,
            });
            setMsg('Saved');
            reload();
          } catch (x) {
            setMsg((x as Error).message);
          }
        }}
      >
        <label>
          Grace period after expiry (hours, 0 = none)
          <input name="graceHours" type="number" min={0} defaultValue={data.graceHours} />
        </label>
        <label className="check">
          <input
            name="canceledKeeps"
            type="checkbox"
            defaultChecked={data.canceledKeepsAccessUntilPeriodEnd}
          />{' '}
          Canceled subscriptions keep access until the paid period ends
        </label>
        <label>
          Default device limit per license
          <input
            name="defaultMaxDevices"
            type="number"
            min={1}
            max={50}
            defaultValue={data.defaultMaxDevices}
          />
        </label>
        <label>
          Offline token validity (hours)
          <input name="tokenTtlHours" type="number" min={1} max={336} defaultValue={data.tokenTtlHours} />
        </label>
        <label className="wide">
          Bank transfer instructions shown at checkout
          <textarea name="bank" rows={4} defaultValue={data.bankTransferInstructions} />
        </label>
        <label>
          Latest desktop version (e.g. 0.2.0; empty = none)
          <input name="relVersion" defaultValue={data.latestRelease?.version ?? ''} pattern="\d+\.\d+\.\d+" />
        </label>
        <label>
          Installer URL (https)
          <input name="relUrl" type="url" defaultValue={data.latestRelease?.url ?? ''} />
        </label>
        <label>
          Installer SHA-256
          <input name="relSha" defaultValue={data.latestRelease?.sha256 ?? ''} pattern="[0-9a-fA-F]{64}" />
        </label>
        <label>
          Release notes
          <input name="relNotes" defaultValue={data.latestRelease?.notes ?? ''} />
        </label>
        <button type="submit">Save settings</button>
        {msg && <span className="hint">{msg}</span>}
      </form>
      <h2>Payment providers</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.providers.map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td>
              <td>
                <Status value={p.configured ? 'active' : 'not_configured'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
