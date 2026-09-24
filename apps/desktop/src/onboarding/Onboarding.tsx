import { useState } from 'react';
import { go } from '../lib/actions';
import { useStore } from '../lib/store';

const KEY = 'jarvis.onboarded.v1';

/** First-run guide: model key, license, voice. Only shows steps that are not yet done. */
export function Onboarding() {
  const status = useStore((s) => s.status);
  const license = useStore((s) => s.license);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed || !status) return null;
  const modelOk = status.capabilities.find((c) => c.id === 'models')?.state === 'active';
  const licOk = !!license?.premium;
  if (modelOk && licOk) return null;
  const close = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };
  return (
    <div className="onboarding" role="dialog" aria-label="Welcome">
      <h2>Welcome to JARVIS</h2>
      <ol>
        <li className={licOk ? 'done' : ''}>Activate your subscription <button className="link" onClick={() => go('account')}>Account</button></li>
        <li className={modelOk ? 'done' : ''}>Connect an AI model provider (OpenRouter key) <button className="link" onClick={() => go('settings')}>Settings</button></li>
        <li>Optional: add a web-search key and choose your voice language</li>
      </ol>
      <button onClick={close}>Got it</button>
    </div>
  );
}
