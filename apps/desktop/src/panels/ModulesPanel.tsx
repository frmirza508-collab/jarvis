import { useEffect, useState } from 'react';
import { core, go } from '../lib/actions';
import { useStore } from '../lib/store';
import { Glass, StateBadge } from '../components/Glass';
import type { SkillInfo, ToolInfo } from '../lib/types';

export function ModulesPanel() {
  const caps = useStore((s) => s.status?.capabilities ?? []);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  useEffect(() => {
    void core().get<ToolInfo[]>('/tools').then(setTools);
    void core().get<SkillInfo[]>('/skills').then(setSkills);
  }, [caps]);
  const modules = [...new Set(tools.map((t) => t.module))];
  return (
    <>
      <Glass title="Capabilities" className="side-left" tilt="left">
        <ul className="caps">
          {caps.map((c) => (
            <li key={c.id}>
              <StateBadge state={c.state} /> <b>{c.label}</b>
              {(c.requirement || c.reason) && <div className="hint">{c.requirement ?? c.reason}</div>}
              {c.state === 'not_configured' && (
                <button className="link small" onClick={() => go('settings')}>
                  Configure
                </button>
              )}
            </li>
          ))}
        </ul>
      </Glass>
      <Glass title="Modules · tools · skills" className="side-right" tilt="right">
        {modules.map((m) => (
          <details key={m} open>
            <summary>{m}</summary>
            <ul className="tools">
              {tools
                .filter((t) => t.module === m)
                .map((t) => (
                  <li key={t.id}>
                    <code>{t.id}</code> <StateBadge state={t.status.state} /> — {t.description}{' '}
                    <small>[{t.categories.join(', ')}]</small>
                  </li>
                ))}
            </ul>
          </details>
        ))}
        <h3>Skills (reusable workflows)</h3>
        <ul className="tools">
          {skills.map((s) => (
            <li key={s.id}>
              <code>{s.id}</code> — {s.description}{' '}
              <small>
                uses {s.tools.join(', ')} · runs {s.stats.runs}, failures {s.stats.failures}
              </small>
            </li>
          ))}
        </ul>
      </Glass>
    </>
  );
}
