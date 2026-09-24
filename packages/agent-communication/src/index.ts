import {
  AGENT_EVENT_TYPES,
  newId,
  type AgentEvent,
  type AgentEventOf,
  type AgentEventType,
} from '@jarvis/shared';

type Handler<E extends AgentEvent = AgentEvent> = (e: E) => unknown;

export type EventDraft<T extends AgentEventType> = Omit<AgentEventOf<T>, 'id' | 'ts'>;

/**
 * Typed in-process agent bus. Events are validated against the contract
 * before delivery; handlers subscribe by event type, recipient, or task.
 * A bounded history is kept for the UI timeline and for replay in tests.
 */
export class AgentBus {
  private handlers = new Map<string, Set<Handler>>();
  private history: AgentEvent[] = [];

  constructor(private readonly historyLimit = 5000) {}

  publish<T extends AgentEventType>(draft: EventDraft<T>): AgentEventOf<T> {
    if (!AGENT_EVENT_TYPES.includes(draft.type)) throw new Error(`Unknown event type: ${String(draft.type)}`);
    if (!draft.from || !draft.taskId) throw new Error('Event requires from and taskId');
    const event = { ...draft, id: newId('evt'), ts: new Date().toISOString() } as AgentEventOf<T>;
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.shift();
    const keys = ['*', `type:${event.type}`, `task:${event.taskId}`];
    if (event.to) keys.push(`to:${event.to}`);
    for (const k of keys) {
      for (const h of this.handlers.get(k) ?? []) {
        try {
          const r = h(event);
          if (r instanceof Promise) r.catch((e) => console.error('bus handler error', e));
        } catch (e) {
          console.error('bus handler error', e);
        }
      }
    }
    return event;
  }

  private sub(key: string, h: Handler): () => void {
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }

  onAny(h: Handler): () => void {
    return this.sub('*', h);
  }
  on<T extends AgentEventType>(type: T, h: Handler<AgentEventOf<T>>): () => void {
    return this.sub(`type:${type}`, h as Handler);
  }
  onTask(taskId: string, h: Handler): () => void {
    return this.sub(`task:${taskId}`, h);
  }
  onRecipient(agentId: string, h: Handler): () => void {
    return this.sub(`to:${agentId}`, h);
  }

  /** Resolve with the first event matching predicate, or reject on timeout. */
  waitFor<T extends AgentEventType>(
    type: T,
    pred: (e: AgentEventOf<T>) => boolean,
    timeoutMs = 30_000,
  ): Promise<AgentEventOf<T>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      const off = this.on(type, (e) => {
        if (pred(e)) {
          clearTimeout(timer);
          off();
          resolve(e);
        }
      });
    });
  }

  getHistory(filter?: { taskId?: string; limit?: number }): AgentEvent[] {
    let h = filter?.taskId ? this.history.filter((e) => e.taskId === filter.taskId) : this.history;
    if (filter?.limit) h = h.slice(-filter.limit);
    return [...h];
  }
}
