import { useEffect, useRef, useState } from 'react';
import { cancelRequest, go, sendRequest } from '../lib/actions';
import { useStore } from '../lib/store';
import { Glass } from '../components/Glass';
import { toggleMicrophone, pushToTalk, speakText } from '../voice-ui/voice-controller';
import { voiceEngine } from '../voice-ui/voice-controller';

const VOICE_LABEL: Record<string, string> = {
  idle: 'Ready',
  listening: 'Listening…',
  transcribing: 'Understanding…',
  thinking: 'Working…',
  speaking: 'Speaking',
};

export function CommandCenter() {
  const messages = useStore((s) => s.messages);
  const live = useStore((s) => s.live);
  const voice = useStore((s) => s.voice);
  const prefs = useStore((s) => s.prefs);
  const license = useStore((s) => s.license);
  const modelsOk = useStore((s) => s.status?.capabilities.find((c) => c.id === 'models')?.state === 'active');
  const [text, setText] = useState('');
  const [micOn, setMicOn] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    log.current?.scrollTo({
      top: log.current.scrollHeight,
      behavior: prefs.reducedMotion ? 'auto' : 'smooth',
    });
  }, [messages, prefs.reducedMotion]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        go('command');
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onReply = (ev: Event) => {
      const r = (ev as CustomEvent<{ requestId: string; reply: string; language: string }>).detail;
      const typed = useTyped.has(r.requestId);
      if (typed && prefs.speakReplies && micOn) speakText(r.reply, r.language);
      useTyped.delete(r.requestId);
    };
    window.addEventListener('jarvis-reply', onReply);
    return () => window.removeEventListener('jarvis-reply', onReply);
  }, [prefs.speakReplies, micOn]);

  const submit = async () => {
    const t = text;
    setText('');
    const id = await sendRequest(t);
    if (id) useTyped.add(id);
  };

  const running = Object.values(live);
  return (
    <Glass
      title="Command"
      className="command"
      tilt="left"
      actions={<span className={`voice-state vs-${voice.state}`}>{VOICE_LABEL[voice.state]}</span>}
    >
      {!modelsOk && (
        <div className="banner warn">
          No AI model configured.{' '}
          <button className="link" onClick={() => go('settings')}>
            Add your OpenRouter key
          </button>
        </div>
      )}
      {license && !license.premium && (
        <div className="banner warn">
          {license.status === 'expired' ? 'Subscription expired.' : 'No active subscription.'}{' '}
          <button className="link" onClick={() => go('account')}>
            Open Account
          </button>
        </div>
      )}
      <div className="log" ref={log} aria-live="polite">
        {messages.length === 0 && (
          <div className="welcome">
            <p>Good to see you. Ask anything — in English, اردو or 中文.</p>
            <ul>
              <li>“Research 5 competitors of my product and save a PDF comparison”</li>
              <li>“Run the tests in D:\\projects\\shop and fix the failing ones”</li>
              <li>“میرے ڈاؤن لوڈز فولڈر میں پی ڈی ایف فائلیں تلاش کرو”</li>
            </ul>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`msg msg-${m.role} ${m.status ?? ''}`}
            dir={m.language === 'ur' ? 'rtl' : 'auto'}
          >
            <div className="msg-text">{m.text}</div>
            {m.result && (
              <div className="msg-meta">
                {m.result.agents.filter((a) => a !== 'orchestrator' && a !== 'final-verification').length >
                  0 && <span>{m.result.agents.length - 2} specialists</span>}
                {Object.values(m.result.outputs)
                  .flatMap((o) => o.artifacts)
                  .map((a) => (
                    <span key={a.value} className="artifact" title={a.value}>
                      📄 {a.value.split(/[\\/]/).pop()}
                    </span>
                  ))}
                {!m.result.verification.ok && (
                  <span className="warn">verification: {m.result.verification.problems.join('; ')}</span>
                )}
              </div>
            )}
            {m.status === 'pending' && m.requestId && (
              <button className="link small" onClick={() => void cancelRequest(m.requestId!)}>
                Cancel
              </button>
            )}
          </div>
        ))}
        {running.map((r) => (
          <div key={r.id} className="progress-feed">
            {r.progress.slice(-4).map((p, i) => (
              <div key={i} className="progress-line">
                <b>{p.from}</b> {p.message}
              </div>
            ))}
            <button className="link small" onClick={() => go('tasks')}>
              View task graph →
            </button>
          </div>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <button
          type="button"
          className={`mic ${micOn ? 'on' : ''}`}
          aria-label={micOn ? 'Turn microphone off' : 'Turn microphone on'}
          onClick={async () => {
            await toggleMicrophone().catch(() => {});
            setMicOn(voiceEngine().active);
          }}
          onMouseDown={() => micOn && !prefs.handsFree && pushToTalk(true)}
          onMouseUp={() => micOn && !prefs.handsFree && pushToTalk(false)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <textarea
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Tell JARVIS what to do…  (Ctrl+K)"
          rows={2}
          dir="auto"
          aria-label="Command"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button type="submit" className="send" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </Glass>
  );
}

const useTyped = new Set<string>();
