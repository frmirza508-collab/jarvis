import { useState } from 'react';
import { core, go, refreshAgents } from '../lib/actions';
import { notify, useStore } from '../lib/store';
import { Glass, StateBadge } from '../components/Glass';
import type { AgentInfo } from '../lib/types';

function rate(a: AgentInfo): string {
  const done = a.metrics.tasksSucceeded + a.metrics.tasksFailed;
  return done ? `${Math.round((a.metrics.tasksSucceeded / done) * 100)}%` : '—';
}
function latency(a: AgentInfo): string {
  const done = a.metrics.tasksSucceeded + a.metrics.tasksFailed;
  return done ? `${(a.metrics.totalLatencyMs / done / 1000).toFixed(1)}s` : '—';
}

export function AgentsPanel() {
  const agents = useStore((s) => s.agents);
  const selected = useStore((s) => s.selectedAgent);
  const [filter, setFilter] = useState('');
  const [brief, setBrief] = useState('');
  const [creating, setCreating] = useState(false);
  const list = Object.values(agents).filter(
    (a) =>
      !filter ||
      `${a.name} ${a.department} ${a.capabilities.join(' ')}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const a = selected ? agents[selected] : undefined;
  return (
    <>
      <Glass
        title={`Agent constellation · ${Object.keys(agents).length} specialists`}
        className="side-left"
        tilt="left"
      >
        <input
          className="filter"
          placeholder="Filter by name, department or capability"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter agents"
        />
        <table className="dense">
          <thead>
            <tr>
              <th>Agent</th>
              <th>State</th>
              <th>Success</th>
              <th>Avg</th>
              <th>Tasks</th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr
                key={x.id}
                className={x.id === selected ? 'sel' : ''}
                onClick={() => go('agents', { agent: x.id })}
              >
                <td>
                  {x.name}
                  {x.dynamic && <small> · dynamic</small>}
                </td>
                <td>
                  <StateBadge state={x.health.state} />
                </td>
                <td>{rate(x)}</td>
                <td>{latency(x)}</td>
                <td>{x.metrics.tasksStarted}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <details
          className="create-agent"
          open={creating}
          onToggle={(e) => setCreating((e.target as HTMLDetailsElement).open)}
        >
          <summary>Create a new specialist</summary>
          <textarea
            rows={3}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Describe the specialist you need, e.g. 'An agent that prepares Pakistani tax filing checklists from my documents'"
          />
          <button
            disabled={brief.trim().length < 10}
            onClick={async () => {
              try {
                const def = await core().post<{ id: string; name: string }>('/agents', { brief });
                await refreshAgents();
                notify('success', `Created ${def.name}`);
                setBrief('');
                go('agents', { agent: def.id });
              } catch (e) {
                notify('error', (e as Error).message);
              }
            }}
          >
            Build agent
          </button>
        </details>
      </Glass>
      {a && (
        <Glass
          title={a.name}
          className="side-right"
          tilt="right"
          actions={<StateBadge state={a.health.state} />}
        >
          <p>{a.description}</p>
          <dl className="kv">
            <dt>Department</dt>
            <dd>{a.department}</dd>
            <dt>Model role</dt>
            <dd>{a.modelRole}</dd>
            <dt>Capabilities</dt>
            <dd>{a.capabilities.join(', ')}</dd>
            <dt>Permissions</dt>
            <dd>{a.permissions.join(', ')}</dd>
            <dt>Tools</dt>
            <dd>{a.tools.join(', ')}</dd>
            <dt>Skills</dt>
            <dd>{a.skills.join(', ') || '—'}</dd>
            <dt>Success rate</dt>
            <dd>
              {rate(a)} ({a.metrics.tasksSucceeded}/{a.metrics.tasksSucceeded + a.metrics.tasksFailed})
            </dd>
            <dt>Avg latency</dt>
            <dd>{latency(a)}</dd>
            <dt>Tool errors</dt>
            <dd>{a.metrics.toolErrors}</dd>
            <dt>Review corrections</dt>
            <dd>{a.metrics.reviewCorrections}</dd>
            {a.health.unavailableTools.length > 0 && (
              <>
                <dt>Unavailable tools</dt>
                <dd className="warn">{a.health.unavailableTools.join(', ')}</dd>
              </>
            )}
            {a.health.lastError && (
              <>
                <dt>Last error</dt>
                <dd className="warn">{a.health.lastError}</dd>
              </>
            )}
          </dl>
          <div className="row">
            <button
              onClick={async () => {
                await core().patch(`/agents/${a.id}`, { enabled: a.health.state === 'disabled' });
                await refreshAgents();
              }}
            >
              {a.health.state === 'disabled' ? 'Enable' : 'Disable'}
            </button>
            {a.dynamic && (
              <button
                className="danger"
                onClick={async () => {
                  await core().del(`/agents/${a.id}`);
                  await refreshAgents();
                  go('agents', { agent: '' });
                }}
              >
                Remove
              </button>
            )}
          </div>
        </Glass>
      )}
    </>
  );
}

export function DepartmentsPanel() {
  const agents = useStore((s) => s.agents);
  const dept = useStore((s) => s.selectedDepartment) ?? 'executive';
  const all = Object.values(agents);
  const depts = [...new Set(all.map((a) => a.department))];
  const members = all.filter((a) => a.department === dept);
  const sum = (k: 'tasksSucceeded' | 'tasksFailed' | 'toolErrors') =>
    members.reduce((n, a) => n + a.metrics[k], 0);
  return (
    <>
      <Glass title="Departments" className="side-left" tilt="left">
        <ul className="menu">
          {depts.map((d) => (
            <li key={d}>
              <button
                className={d === dept ? 'sel' : ''}
                onClick={() => go('departments', { department: d })}
              >
                {d} <small>{all.filter((a) => a.department === d).length}</small>
              </button>
            </li>
          ))}
        </ul>
      </Glass>
      <Glass title={dept} className="side-right" tilt="right">
        <p>
          {members.length} specialists · {members.filter((m) => m.health.state === 'busy').length} working now
          · {sum('tasksSucceeded')} succeeded · {sum('tasksFailed')} failed · {sum('toolErrors')} tool errors
        </p>
        <ul className="members">
          {members.map((m) => (
            <li key={m.id}>
              <button className="link" onClick={() => go('agents', { agent: m.id })}>
                {m.name}
              </button>{' '}
              <StateBadge state={m.health.state} />
              <br />
              <small>{m.capabilities.join(', ')}</small>
            </li>
          ))}
        </ul>
      </Glass>
    </>
  );
}
