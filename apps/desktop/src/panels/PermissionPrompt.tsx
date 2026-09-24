import { decidePermission } from '../lib/actions';
import { useStore } from '../lib/store';

const RISK_TEXT: Record<string, string> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', critical: 'Critical — cannot be undone' };

/** Human-in-the-loop gate: every protected action is decided here, never by the model. */
export function PermissionPrompt() {
  const pending = useStore((s) => s.permissions);
  const agents = useStore((s) => s.agents);
  const req = pending[0];
  if (!req) return null;
  const critical = req.risk === 'critical';
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <div className={`permission risk-${req.risk}`}>
        <div className="perm-ring" aria-hidden />
        <h2 id="perm-title">Permission required</h2>
        <p className="perm-actor">{agents[req.actor]?.name ?? req.actor} wants to:</p>
        <p className="perm-desc">{req.description}</p>
        {req.target && <p className="perm-target"><code>{req.target}</code></p>}
        <p className="perm-meta">
          <span className={`risk risk-${req.risk}`}>{RISK_TEXT[req.risk]}</span> · {req.categories.join(', ')} · <code>{req.action}</code>
        </p>
        <div className="perm-actions">
          <button className="deny" onClick={() => void decidePermission(req.id, 'deny')} autoFocus>Deny</button>
          <button className="allow" onClick={() => void decidePermission(req.id, 'allow_once')}>Allow once</button>
          {!critical && <button onClick={() => void decidePermission(req.id, 'allow_always')} title="Creates a rule for this action and location">Always allow here</button>}
        </div>
        {pending.length > 1 && <p className="perm-more">{pending.length - 1} more request(s) waiting</p>}
      </div>
    </div>
  );
}
