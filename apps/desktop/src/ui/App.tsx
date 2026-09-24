import { lazy, Suspense, useEffect } from 'react';
import { connect, go } from '../lib/actions';
import { useStore, type ViewId } from '../lib/store';
import { CommandCenter } from '../command-center/CommandCenter';
import { PermissionPrompt } from '../panels/PermissionPrompt';
import { AgentsPanel, DepartmentsPanel } from '../agent-visualizer/AgentsPanel';
import { TaskGraphPanel } from '../task-graph/TaskGraphPanel';
import { ModulesPanel } from '../panels/ModulesPanel';
import { MemoryPanel } from '../panels/MemoryPanel';
import { SystemPanel } from '../panels/SystemPanel';
import { ActivityPanel } from '../panels/ActivityPanel';
import { AccountPanel } from '../panels/AccountPanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { VoicePanel } from '../voice-ui/VoicePanel';
import { Onboarding } from '../onboarding/Onboarding';

const World = lazy(() => import('../scenes/World').then((m) => ({ default: m.World })));

const NAV: Array<[ViewId, string, string]> = [
  ['command', 'Command', '1'],
  ['voice', 'Voice', '2'],
  ['agents', 'Agents', '3'],
  ['tasks', 'Tasks', '4'],
  ['departments', 'Departments', '5'],
  ['modules', 'Modules', '6'],
  ['memory', 'Memory', '7'],
  ['system', 'System', '8'],
  ['activity', 'Activity', '9'],
  ['settings', 'Settings', '0'],
  ['account', 'Account', ''],
];

function StatusBar() {
  const connection = useStore((s) => s.connection);
  const status = useStore((s) => s.status);
  const license = useStore((s) => s.license);
  const live = useStore((s) => s.live);
  const fps = useStore((s) => s.fps);
  const model = status?.capabilities.find((c) => c.id === 'models');
  return (
    <footer className="statusbar" aria-label="System status">
      <span className={`dot ${connection}`} /> core {connection}
      <span>· models <b className={`st-${model?.state}`}>{model?.state?.replace('_', ' ') ?? '—'}</b></span>
      <span>· license <b className={license?.premium ? 'st-active' : 'st-not_configured'}>{license ? (license.mode === 'development' ? (license.premium ? 'development' : 'not configured') : license.premium ? (license.plan ?? 'active') : (license.status ?? 'inactive')) : '—'}</b></span>
      <span>· {status?.agents.total ?? 0} agents</span>
      <span>· {Object.keys(live).length} running</span>
      <span className="right">{fps} fps</span>
    </footer>
  );
}

function Notices() {
  const notices = useStore((s) => s.notices);
  return (
    <div className="notices" aria-live="assertive">
      {notices.map((n) => (<div key={n.id} className={`notice ${n.level}`}>{n.text}</div>))}
    </div>
  );
}

function ViewPanels({ view }: { view: ViewId }) {
  switch (view) {
    case 'command': return null;
    case 'voice': return <VoicePanel />;
    case 'agents': return <AgentsPanel />;
    case 'tasks': return <TaskGraphPanel />;
    case 'departments': return <DepartmentsPanel />;
    case 'modules': return <ModulesPanel />;
    case 'memory': return <MemoryPanel />;
    case 'system': return <SystemPanel />;
    case 'activity': return <ActivityPanel />;
    case 'settings': return <SettingsPanel />;
    case 'account': return <AccountPanel />;
  }
}

export function App() {
  const connection = useStore((s) => s.connection);
  const error = useStore((s) => s.connectionError);
  const view = useStore((s) => s.view);
  const reduced = useStore((s) => s.prefs.reducedMotion);
  const perms = useStore((s) => s.permissions.length);

  useEffect(() => {
    void connect();
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const hit = NAV.find(([, , k]) => k && k === e.key);
      if (hit) go(hit[0]);
      if (e.key === 'Escape') go('command');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('reduced-motion', reduced);
  }, [reduced]);

  if (connection === 'error') {
    return (
      <div className="fatal">
        <h1>JARVIS core unavailable</h1>
        <p>{error}</p>
        <button onClick={() => void connect()}>Retry</button>
      </div>
    );
  }

  return (
    <div className={`app view-${view}`}>
      <Suspense fallback={<div className="world loading">Initialising 3D core…</div>}>
        <World />
      </Suspense>
      <header className="topbar">
        <div className="brand">J.A.R.V.I.S</div>
        <nav aria-label="Views">
          {NAV.map(([id, label, key]) => (
            <button key={id} className={view === id ? 'sel' : ''} onClick={() => go(id)} title={key ? `${label} (${key})` : label}>{label}</button>
          ))}
        </nav>
      </header>
      <main className="hud">
        <CommandCenter />
        <ViewPanels view={view} />
      </main>
      {perms > 0 && <PermissionPrompt />}
      <Onboarding />
      <Notices />
      <StatusBar />
    </div>
  );
}
