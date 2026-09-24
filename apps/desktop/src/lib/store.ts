import { useSyncExternalStore } from 'react';
import type {
  AgentEvent,
  AgentInfo,
  AuditEntry,
  CoreStatus,
  LicenseStatus,
  NodeState,
  PermissionRequest,
  RequestResult,
  ServerMessage,
} from './types';

export type ViewId =
  | 'command'
  | 'agents'
  | 'tasks'
  | 'departments'
  | 'modules'
  | 'voice'
  | 'memory'
  | 'system'
  | 'settings'
  | 'account'
  | 'activity';

export interface ChatMessage {
  id: string;
  role: 'user' | 'jarvis' | 'system';
  text: string;
  requestId?: string;
  status?: 'pending' | 'done' | 'error' | 'cancelled';
  result?: RequestResult;
  language?: string;
  ts: number;
}

export interface LiveRequest {
  id: string;
  text: string;
  nodes: Record<string, NodeState>;
  progress: Array<{ ts: number; from: string; message: string }>;
  agents: string[];
  startedAt: number;
}

export interface Notice {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
  ts: number;
}

export interface Prefs {
  quality: 'high' | 'medium' | 'low';
  reducedMotion: boolean;
  renderer: 'auto' | 'webgl' | 'webgpu';
  voiceLanguage: 'auto' | string;
  speakReplies: boolean;
  handsFree: boolean;
}

export interface AppState {
  connection: 'connecting' | 'connected' | 'disconnected' | 'error';
  connectionError?: string;
  status?: CoreStatus;
  license?: LicenseStatus | null;
  agents: Record<string, AgentInfo>;
  permissions: PermissionRequest[];
  messages: ChatMessage[];
  live: Record<string, LiveRequest>;
  events: AgentEvent[];
  audit: AuditEntry[];
  notices: Notice[];
  view: ViewId;
  selectedAgent?: string;
  selectedDepartment?: string;
  voice: {
    state: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
    level: number;
    lastLanguage?: string;
  };
  prefs: Prefs;
  fps: number;
  rendererKind?: 'webgpu' | 'webgl';
}

const PREFS_KEY = 'jarvis.prefs.v1';
function loadPrefs(): Prefs {
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const d: Prefs = {
    quality: 'high',
    reducedMotion: reduced,
    renderer: 'auto',
    voiceLanguage: 'auto',
    speakReplies: true,
    handsFree: false,
  };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return d;
  }
}

let state: AppState = {
  connection: 'connecting',
  agents: {},
  permissions: [],
  messages: [],
  live: {},
  events: [],
  audit: [],
  notices: [],
  view: 'command',
  voice: { state: 'idle', level: 0 },
  prefs: loadPrefs(),
  fps: 60,
};

const listeners = new Set<() => void>();
export function getState(): AppState {
  return state;
}
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if (p.prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch {
      /* storage unavailable */
    }
  }
  for (const l of listeners) l();
}
export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
    () => sel(state),
  );
}

let noticeSeq = 0;
export function notify(level: Notice['level'], text: string): void {
  const n: Notice = { id: `n${++noticeSeq}`, level, text, ts: Date.now() };
  setState((s) => ({ notices: [...s.notices.slice(-4), n] }));
  setTimeout(
    () => setState((s) => ({ notices: s.notices.filter((x) => x.id !== n.id) })),
    level === 'error' ? 9000 : 5000,
  );
}

/** Results/errors that arrived before the UI registered the request (fast replies race the HTTP response). */
const early = new Map<string, ServerMessage>();
export function takeEarly(requestId: string): ServerMessage | undefined {
  const m = early.get(requestId);
  early.delete(requestId);
  return m;
}
const hasPending = (requestId: string) =>
  state.messages.some((x) => x.requestId === requestId && x.role === 'jarvis');

function rootRequestId(taskId: string): string {
  return taskId.split(':')[0]!;
}

/** Reduce a server push message into app state. */
export function applyServerMessage(m: ServerMessage): void {
  switch (m.kind) {
    case 'hello':
      setState({ permissions: m.pendingPermissions });
      break;
    case 'permission':
      setState((s) => ({ permissions: [...s.permissions.filter((p) => p.id !== m.request.id), m.request] }));
      break;
    case 'permission.resolved':
      setState((s) => ({ permissions: s.permissions.filter((p) => p.id !== m.id) }));
      break;
    case 'audit':
      setState((s) => ({ audit: [...s.audit.slice(-299), m.entry] }));
      break;
    case 'agent':
      setState((s) => {
        const cur = s.agents[m.agent.id];
        if (!cur) return {};
        return {
          agents: {
            ...s.agents,
            [m.agent.id]: {
              ...cur,
              health: m.agent.health,
              metrics: m.agent.metrics,
              activeTasks: m.agent.activeTasks,
            },
          },
        };
      });
      break;
    case 'license':
      setState({ license: m.status });
      break;
    case 'bus': {
      const e = m.event;
      setState((s) => {
        const rid = rootRequestId(e.taskId);
        const live = s.live[rid];
        const patch: Partial<AppState> = { events: [...s.events.slice(-499), e] };
        if (live) {
          const msg =
            e.type === 'TASK_PROGRESS'
              ? String(e.payload.message)
              : e.type === 'TASK_FAILED'
                ? `failed: ${String(e.payload.error)}`
                : e.type === 'BLOCKED'
                  ? `blocked: ${String(e.payload.reason)}`
                  : e.type === 'REVIEW_RESULT'
                    ? e.payload.approved
                      ? 'review approved'
                      : `review: ${(e.payload.issues as string[]).join('; ')}`
                    : e.type === 'TASK_ACCEPTED'
                      ? 'accepted'
                      : undefined;
          const agents =
            e.from !== 'user' && e.from !== 'orchestrator' && !live.agents.includes(e.from)
              ? [...live.agents, e.from]
              : live.agents;
          patch.live = {
            ...s.live,
            [rid]: {
              ...live,
              agents,
              progress: msg
                ? [...live.progress.slice(-80), { ts: Date.now(), from: e.from, message: msg }]
                : live.progress,
            },
          };
        }
        return patch;
      });
      break;
    }
    case 'request.done': {
      const r = m.result;
      if (!hasPending(r.requestId)) {
        early.set(r.requestId, m);
        break;
      }
      setState((s) => {
        const { [r.requestId]: _done, ...rest } = s.live;
        return {
          live: rest,
          messages: s.messages.map((x) =>
            x.requestId === r.requestId && x.role === 'jarvis'
              ? { ...x, text: r.reply, status: 'done', result: r, language: r.language }
              : x,
          ),
        };
      });
      window.dispatchEvent(new CustomEvent('jarvis-reply', { detail: r }));
      break;
    }
    case 'request.error':
      if (!hasPending(m.requestId)) {
        early.set(m.requestId, m);
        break;
      }
      setState((s) => {
        const { [m.requestId]: _gone, ...rest } = s.live;
        return {
          live: rest,
          messages: s.messages.map((x) =>
            x.requestId === m.requestId && x.role === 'jarvis'
              ? { ...x, text: m.message, status: m.code === 'CANCELLED' ? 'cancelled' : 'error' }
              : x,
          ),
        };
      });
      if (m.code !== 'CANCELLED') notify('error', m.message);
      break;
  }
}

/** Graph and reply-delta stream (not part of ServerMessage union for brevity). */
export function applyLiveMessage(
  m:
    | { kind: 'graph'; requestId: string; event: { kind: string; node?: NodeState } }
    | { kind: 'delta'; requestId: string; text: string },
): void {
  if (m.kind === 'graph' && m.event.kind === 'node' && m.event.node) {
    const node = m.event.node;
    setState((s) => {
      const live = s.live[m.requestId];
      if (!live) return {};
      return { live: { ...s.live, [m.requestId]: { ...live, nodes: { ...live.nodes, [node.id]: node } } } };
    });
  } else if (m.kind === 'delta') {
    setState((s) => ({
      messages: s.messages.map((x) =>
        x.requestId === m.requestId && x.role === 'jarvis' && x.status === 'pending'
          ? { ...x, text: (x.text === '…' ? '' : x.text) + m.text }
          : x,
      ),
    }));
  }
}
