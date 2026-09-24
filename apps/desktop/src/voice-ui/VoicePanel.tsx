import { useStore } from '../lib/store';
import { Glass, StateBadge } from '../components/Glass';
import { go } from '../lib/actions';

export function VoicePanel() {
  const voice = useStore((s) => s.voice);
  const stt = useStore((s) => s.status?.capabilities.find((c) => c.id === 'voice.stt'));
  const tts = useStore((s) => s.status?.capabilities.find((c) => c.id === 'voice.tts'));
  const prefs = useStore((s) => s.prefs);
  return (
    <Glass title="Voice" className="side-right" tilt="right">
      <dl className="kv">
        <dt>State</dt>
        <dd>
          <StateBadge state={voice.state} />
        </dd>
        <dt>Input level</dt>
        <dd>
          <meter min={0} max={1} value={voice.level} />
        </dd>
        <dt>Last language</dt>
        <dd>{voice.lastLanguage ?? '—'}</dd>
        <dt>Speech recognition</dt>
        <dd>
          {stt && <StateBadge state={stt.state} />} {stt?.requirement}
        </dd>
        <dt>Speech output</dt>
        <dd>
          {tts && <StateBadge state={tts.state} />} {tts?.reason}
        </dd>
        <dt>Mode</dt>
        <dd>{prefs.handsFree ? 'Hands-free' : 'Click / hold to talk'}</dd>
      </dl>
      <p className="hint">
        Speak in English, Urdu or Mandarin. While JARVIS is speaking, just start talking to interrupt.
      </p>
      <button onClick={() => go('settings')}>Voice settings</button>
    </Glass>
  );
}
