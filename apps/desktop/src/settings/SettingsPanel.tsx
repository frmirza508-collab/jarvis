import { useEffect, useState } from 'react';
import { core, refreshAgents, refreshStatus } from '../lib/actions';
import { notify, setState, useStore } from '../lib/store';
import { Glass, StateBadge } from '../components/Glass';

const SECRET_LABELS: Record<string, string> = {
  OPENROUTER_API_KEY: 'OpenRouter API key (primary model gateway)',
  BRAVE_SEARCH_API_KEY: 'Brave Search API key (web research)',
  TAVILY_API_KEY: 'Tavily API key (web research, alternative)',
  STT_API_KEY: 'Speech-to-text key (Whisper-compatible)',
  TTS_API_KEY: 'Cloud text-to-speech key (optional)',
  LOCAL_LLM_API_KEY: 'Local model server key (optional)',
};

type Target = { provider: string; model: string };
type Roles = Record<'fast' | 'reasoning' | 'coding' | 'vision' | 'audio' | 'embedding', Target[]>;
interface Policy { confirmAtOrAbove: string; autoAllow: string[]; rules: Array<{ id: string; action: string; targetPrefix?: string; effect: string; maxRisk: string; createdAt: string }> }
interface Settings { roles: Roles; permissionPolicy: Policy; workspace: string; languages: Array<{ code: string; name: string; nativeName: string; enabled: boolean }> }

export function SettingsPanel() {
  const [tab, setTab] = useState<'providers' | 'models' | 'voice' | 'permissions' | 'display'>('providers');
  return (
    <Glass title="Settings" className="settings wide" tilt="none">
      <nav className="tabs" role="tablist">
        {(['providers', 'models', 'voice', 'permissions', 'display'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'sel' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      {tab === 'providers' && <Providers />}
      {tab === 'models' && <Models />}
      {tab === 'voice' && <VoiceSettings />}
      {tab === 'permissions' && <Permissions />}
      {tab === 'display' && <Display />}
    </Glass>
  );
}

function Providers() {
  const [secrets, setSecrets] = useState<Array<{ name: string; configured: boolean }>>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const load = () => void core().get<typeof secrets>('/secrets').then(setSecrets);
  useEffect(load, []);
  return (
    <div className="form">
      <p className="hint">Keys are encrypted with a key held in Windows Credential Manager. They are never shown again, never logged, and never passed to commands JARVIS runs.</p>
      {secrets.map((s) => (
        <div key={s.name} className="secret-row">
          <label htmlFor={s.name}>{SECRET_LABELS[s.name] ?? s.name} <StateBadge state={s.configured ? 'configured' : 'not_configured'} /></label>
          <div className="row">
            <input id={s.name} type="password" autoComplete="off" placeholder={s.configured ? '•••••••• (stored)' : 'Paste key'} value={values[s.name] ?? ''} onChange={(e) => setValues({ ...values, [s.name]: e.target.value })} />
            <button
              disabled={(values[s.name] ?? '').length < 8}
              onClick={async () => {
                try {
                  await core().put(`/secrets/${s.name}`, { value: values[s.name] });
                  setValues({ ...values, [s.name]: '' });
                  notify('success', 'Saved securely');
                  load();
                  await Promise.all([refreshStatus(), refreshAgents()]);
                } catch (e) {
                  notify('error', (e as Error).message);
                }
              }}
            >Save</button>
            {s.configured && <button className="danger" onClick={async () => { await core().del(`/secrets/${s.name}`); load(); await refreshStatus(); }}>Remove</button>}
            {s.name === 'OPENROUTER_API_KEY' && s.configured && (
              <button onClick={async () => {
                try {
                  const r = await core().post<{ model: string; latencyMs: number }>('/providers/openrouter/test');
                  notify('success', `Connected: ${r.model} in ${r.latencyMs} ms`);
                } catch (e) {
                  notify('error', (e as Error).message);
                }
              }}>Test</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Models() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string }>>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void core().get<Settings>('/settings').then(setSettings);
    void core().get<Array<{ id: string; name: string }>>('/providers/openrouter/models').then(setCatalog).catch((e: Error) => setErr(`Model list unavailable: ${e.message}`));
  }, []);
  if (!settings) return null;
  const roles = settings.roles;
  const update = (role: keyof Roles, i: number, model: string) => {
    const next = structuredClone(roles);
    next[role][i] = { provider: next[role][i]?.provider ?? 'openrouter', model };
    setSettings({ ...settings, roles: next });
  };
  return (
    <div className="form">
      <p className="hint">Each role has an ordered fallback chain. JARVIS tries the next model when one fails or is rate-limited.</p>
      {err && <p className="warn">{err}</p>}
      <datalist id="models">{catalog.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
      {(Object.keys(roles) as Array<keyof Roles>).filter((r) => r !== 'embedding').map((role) => (
        <div key={role} className="role-row">
          <label>{role}</label>
          {roles[role].map((t, i) => (
            <input key={i} list="models" value={t.model} onChange={(e) => update(role, i, e.target.value)} aria-label={`${role} model ${i + 1}`} />
          ))}
          <button onClick={() => setSettings({ ...settings, roles: { ...roles, [role]: [...roles[role], { provider: 'openrouter', model: '' }] } })}>+ fallback</button>
          {roles[role].length > 1 && <button onClick={() => setSettings({ ...settings, roles: { ...roles, [role]: roles[role].slice(0, -1) } })}>−</button>}
        </div>
      ))}
      <button onClick={async () => {
        try {
          const clean = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v.filter((t) => t.model.trim())])) as Roles;
          await core().put('/settings/roles', clean);
          notify('success', 'Model routing saved');
        } catch (e) {
          notify('error', (e as Error).message);
        }
      }}>Save model routing</button>
    </div>
  );
}

function VoiceSettings() {
  const prefs = useStore((s) => s.prefs);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    void core().get<Settings>('/settings').then(setSettings);
    const load = () => setVoices(typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : []);
    load();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.onvoiceschanged = load;
  }, []);
  const setPrefs = (p: Partial<typeof prefs>) => setState({ prefs: { ...prefs, ...p } });
  return (
    <div className="form">
      <label className="check"><input type="checkbox" checked={prefs.speakReplies} onChange={(e) => setPrefs({ speakReplies: e.target.checked })} /> Speak replies aloud</label>
      <label className="check"><input type="checkbox" checked={prefs.handsFree} onChange={(e) => setPrefs({ handsFree: e.target.checked })} /> Hands-free (start listening when I speak; otherwise click-to-talk)</label>
      <label>Recognition language
        <select value={prefs.voiceLanguage} onChange={(e) => setPrefs({ voiceLanguage: e.target.value })}>
          <option value="auto">Auto-detect</option>
          {settings?.languages.filter((l) => l.enabled).map((l) => <option key={l.code} value={l.code}>{l.name} ({l.nativeName})</option>)}
        </select>
      </label>
      <h3>Languages</h3>
      <table className="dense">
        <thead><tr><th>Language</th><th>Enabled</th><th>Windows voices installed</th><th /></tr></thead>
        <tbody>
          {settings?.languages.map((l) => {
            const vs = voices.filter((v) => v.lang.toLowerCase().startsWith(l.code));
            return (
              <tr key={l.code}>
                <td>{l.name} <span dir="auto">{l.nativeName}</span></td>
                <td><input type="checkbox" checked={l.enabled} onChange={async (e) => { await core().put(`/settings/languages/${l.code}`, { enabled: e.target.checked }); setSettings(await core().get<Settings>('/settings')); }} /></td>
                <td>{vs.length ? vs.map((v) => v.name).join(', ') : <span className="warn">none — install via Windows Settings › Time &amp; language › Speech</span>}</td>
                <td>{vs.length > 0 && <button onClick={() => { const u = new SpeechSynthesisUtterance(l.code === 'ur' ? 'السلام علیکم، میں جاروِس ہوں۔' : l.code === 'zh' ? '你好，我是贾维斯。' : 'Hello, I am JARVIS.'); u.voice = vs[0]!; speechSynthesis.speak(u); }}>Test</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">Additional languages are added through the language registry without bulk downloads; each language is enabled individually.</p>
    </div>
  );
}

const CATEGORIES = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'BROWSER', 'SYSTEM', 'SENSITIVE'];
function Permissions() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const load = () => void core().get<Policy>('/permissions/policy').then(setPolicy);
  useEffect(load, []);
  if (!policy) return null;
  const save = async (p: Policy) => {
    setPolicy(await core().put<Policy>('/permissions/policy', p));
    notify('success', 'Permission policy saved');
  };
  return (
    <div className="form">
      <label>Always ask at or above risk
        <select value={policy.confirmAtOrAbove} onChange={(e) => void save({ ...policy, confirmAtOrAbove: e.target.value })}>
          {['low', 'medium', 'high', 'critical'].map((r) => <option key={r}>{r}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Allow without asking (below the threshold)</legend>
        {CATEGORIES.map((c) => (
          <label key={c} className="check"><input type="checkbox" checked={policy.autoAllow.includes(c)} onChange={(e) => void save({ ...policy, autoAllow: e.target.checked ? [...policy.autoAllow, c] : policy.autoAllow.filter((x) => x !== c) })} /> {c}</label>
        ))}
        <p className="hint">DESTRUCTIVE actions (deleting files etc.) always ask. Blocked commands (disk formatting, disabling security, credential dumping) never run.</p>
      </fieldset>
      <h3>Saved rules</h3>
      <table className="dense">
        <thead><tr><th>Action</th><th>Location</th><th>Effect</th><th>Max risk</th><th /></tr></thead>
        <tbody>
          {policy.rules.map((r) => (
            <tr key={r.id}><td><code>{r.action}</code></td><td className="ellipsis">{r.targetPrefix ?? 'anywhere'}</td><td>{r.effect}</td><td>{r.maxRisk}</td><td><button className="danger" onClick={async () => { await core().del(`/permissions/rules/${r.id}`); load(); }}>Remove</button></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Display() {
  const prefs = useStore((s) => s.prefs);
  const renderer = useStore((s) => s.rendererKind);
  const setPrefs = (p: Partial<typeof prefs>) => setState({ prefs: { ...prefs, ...p } });
  return (
    <div className="form">
      <label>3D quality
        <select value={prefs.quality} onChange={(e) => setPrefs({ quality: e.target.value as typeof prefs.quality })}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low (weaker GPUs)</option></select>
      </label>
      <label>Renderer (restart to apply)
        <select value={prefs.renderer} onChange={(e) => setPrefs({ renderer: e.target.value as typeof prefs.renderer })}><option value="auto">Auto (WebGPU when available)</option><option value="webgl">WebGL</option><option value="webgpu">WebGPU</option></select>
      </label>
      <p className="hint">Current renderer: {renderer ?? 'starting'}. Quality lowers automatically if the frame rate drops.</p>
      <label className="check"><input type="checkbox" checked={prefs.reducedMotion} onChange={(e) => setPrefs({ reducedMotion: e.target.checked })} /> Reduced motion</label>
    </div>
  );
}
