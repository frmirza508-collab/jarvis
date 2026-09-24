import { useEffect, useState } from 'react';
import { core } from '../lib/actions';
import { notify } from '../lib/store';
import { Empty, Glass, StateBadge } from '../components/Glass';
import type { MemoryItem } from '../lib/types';

const SCOPES = ['', 'preference', 'project', 'knowledge', 'lesson', 'agent', 'global', 'session'];

export function MemoryPanel() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('');
  const [note, setNote] = useState('');
  const [noteScope, setNoteScope] = useState('preference');
  const load = () =>
    void core()
      .get<MemoryItem[]>(`/memory?${q ? `q=${encodeURIComponent(q)}&` : ''}${scope ? `scope=${scope}` : ''}`)
      .then(setItems);
  useEffect(load, [scope]);
  return (
    <>
      <Glass title="Memory & knowledge" className="side-right" tilt="right">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search memory"
            aria-label="Search memory"
          />
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s || 'all scopes'}
              </option>
            ))}
          </select>
          <button type="submit">Search</button>
        </form>
        {items.length === 0 && <Empty>Nothing stored{q ? ' for this search' : ' yet'}.</Empty>}
        <ul className="memories">
          {items.map((m) => (
            <li key={m.id}>
              <div>
                <StateBadge state={m.scope} />{' '}
                {m.verified ? (
                  <StateBadge state="verified" />
                ) : m.scope === 'lesson' ? (
                  <StateBadge state="unverified" />
                ) : null}{' '}
                <small>
                  {m.source} · used {m.useCount}×
                </small>
              </div>
              <p dir="auto">{m.content}</p>
              <div className="row">
                {m.scope === 'lesson' && !m.verified && (
                  <button
                    onClick={async () => {
                      await core().post(`/memory/${m.id}/verify`);
                      load();
                    }}
                  >
                    Verify lesson
                  </button>
                )}
                <button
                  className="danger"
                  onClick={async () => {
                    await core().del(`/memory/${m.id}`);
                    load();
                  }}
                >
                  Forget
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Glass>
      <Glass title="Teach JARVIS" className="side-left" tilt="left">
        <textarea
          rows={3}
          dir="auto"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. My company is Acme Traders in Lahore; invoices use PKR."
        />
        <div className="row">
          <select value={noteScope} onChange={(e) => setNoteScope(e.target.value)}>
            {SCOPES.filter(Boolean)
              .filter((s) => s !== 'lesson' && s !== 'session')
              .map((s) => (
                <option key={s}>{s}</option>
              ))}
          </select>
          <button
            disabled={!note.trim()}
            onClick={async () => {
              await core().post('/memory', { content: note, scope: noteScope });
              setNote('');
              notify('success', 'Remembered');
              load();
            }}
          >
            Remember
          </button>
        </div>
        <h3>Retention</h3>
        <div className="row">
          <button
            onClick={async () => {
              const r = await core().post<{ removed: number }>('/memory/purge', { expiredOnly: true });
              notify('info', `Removed ${r.removed} expired items`);
              load();
            }}
          >
            Purge expired
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm('Delete all session memories?')) return;
              const r = await core().post<{ removed: number }>('/memory/purge', { scope: 'session' });
              notify('info', `Removed ${r.removed}`);
              load();
            }}
          >
            Clear session memory
          </button>
        </div>
        <p className="hint">
          Lessons are proposed after verified successful tasks and only reused once verified. JARVIS never
          retrains or modifies its underlying models.
        </p>
      </Glass>
    </>
  );
}
