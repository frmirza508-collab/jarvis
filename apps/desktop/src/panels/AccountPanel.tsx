import { useState } from 'react';
import { activateLicense, core, deactivateLicense, refreshLicense } from '../lib/actions';
import { notify, useStore } from '../lib/store';
import { Glass, StateBadge } from '../components/Glass';

const ACCOUNT_URL = (import.meta.env.VITE_ACCOUNT_URL as string | undefined) ?? '';

export function AccountPanel() {
  const license = useStore((s) => s.license);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Glass title="Subscription" className="side-left" tilt="left">
        {!license ? (
          <p>Loading…</p>
        ) : license.mode === 'development' ? (
          <p className="warn">Development license mode (not available in release builds).</p>
        ) : (
          <dl className="kv">
            <dt>Premium features</dt>
            <dd>
              <StateBadge state={license.premium ? 'active' : 'inactive'} />
            </dd>
            <dt>Plan</dt>
            <dd>{license.plan ?? '—'}</dd>
            <dt>Status</dt>
            <dd>{license.status ? <StateBadge state={license.status} /> : '—'}</dd>
            <dt>Access until</dt>
            <dd>{license.entitlementUntil ? new Date(license.entitlementUntil).toLocaleString() : '—'}</dd>
            <dt>Last verified</dt>
            <dd>{license.lastOnlineCheck ? new Date(license.lastOnlineCheck).toLocaleString() : 'never'}</dd>
            <dt>Check result</dt>
            <dd>{license.decision}</dd>
            {license.error && (
              <>
                <dt>Last error</dt>
                <dd className="warn">{license.error}</dd>
              </>
            )}
          </dl>
        )}
        <div className="row">
          {license?.hasKey && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await refreshLicense();
                setBusy(false);
              }}
            >
              Check now
            </button>
          )}
          {license?.hasKey && (
            <button
              className="danger"
              onClick={async () => {
                if (confirm('Deactivate JARVIS on this device? Your files and settings are kept.'))
                  await deactivateLicense();
              }}
            >
              Deactivate this device
            </button>
          )}
        </div>
        <p className="hint">
          If a subscription ends, premium execution stops. Your files, memory and settings on this computer
          are never deleted.
        </p>
      </Glass>
      <Glass title="Activate or renew" className="side-right" tilt="right">
        <div className="plans">
          <div className="plan">
            <h3>Monthly</h3>
            <strong>PKR 4,000</strong>
            <span>per month</span>
          </div>
          <div className="plan">
            <h3>Yearly</h3>
            <strong>PKR 40,000</strong>
            <span>per year</span>
          </div>
        </div>
        {ACCOUNT_URL ? (
          <p>
            Purchase or renew in your account portal:{' '}
            <button
              className="link"
              onClick={() => void core().post('/system/open-url', { url: ACCOUNT_URL })}
            >
              {ACCOUNT_URL}
            </button>
            . After payment is confirmed you receive a license key.
          </p>
        ) : (
          <p className="hint">
            Purchase is handled by your JARVIS provider. After payment is confirmed you receive a license key.
          </p>
        )}
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const s = await activateLicense(key.trim());
              notify(
                s.premium ? 'success' : 'warning',
                s.premium ? 'JARVIS activated' : `License accepted but subscription is ${s.status}`,
              );
              setKey('');
            } catch (err) {
              notify('error', (err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="JRV-XXXXX-XXXXX-XXXXX-XXXXX"
            pattern="JRV(-[0-9A-Z]{5}){4}"
            aria-label="License key"
          />
          <button type="submit" disabled={busy || !/^JRV(-[0-9A-Z]{5}){4}$/.test(key.trim())}>
            Activate
          </button>
        </form>
      </Glass>
    </>
  );
}
