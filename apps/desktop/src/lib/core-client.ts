import type { ServerMessage } from './types';

export interface CoreConnection {
  url: string;
  token: string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

/** Resolve how to reach the local JARVIS core: via the Tauri shell, or dev env vars. */
export async function resolveConnection(): Promise<CoreConnection> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    for (let i = 0; i < 150; i++) {
      const c = await invoke<CoreConnection | null>('core_connection');
      if (c) return c;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('JARVIS core did not start. See %APPDATA%\\JARVIS\\logs\\core.log');
  }
  const params = new URLSearchParams(location.search);
  const url =
    params.get('core') ?? (import.meta.env.VITE_CORE_URL as string | undefined) ?? 'http://127.0.0.1:7801';
  const token =
    params.get('token') ?? (import.meta.env.VITE_CORE_TOKEN as string | undefined) ?? 'dev-token-change-me';
  return { url, token };
}

export class CoreError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class CoreClient {
  private ws?: WebSocket;
  private listeners = new Set<(m: ServerMessage) => void>();
  private stateListeners = new Set<(connected: boolean) => void>();
  private closed = false;
  connected = false;

  constructor(
    public conn: CoreConnection,
    /** Re-resolves the connection after the shell restarted a crashed core (new port and token). */
    private readonly resolver?: () => Promise<CoreConnection>,
  ) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    raw?: { data: Blob; contentType: string; headers?: Record<string, string> },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.conn.token}`,
      ...(raw?.headers ?? {}),
    };
    let payload: BodyInit | undefined;
    if (raw) {
      headers['Content-Type'] = raw.contentType;
      payload = raw.data;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.conn.url}${path}`, { method, headers, body: payload });
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      const j = ct.includes('json')
        ? ((await res.json()) as { error?: string; message?: string })
        : { message: await res.text() };
      throw new CoreError(res.status, j.error ?? 'ERROR', j.message ?? `Request failed (${res.status})`);
    }
    if (ct.includes('json')) return (await res.json()) as T;
    return (await res.blob()) as T;
  }

  get = <T>(p: string) => this.request<T>('GET', p);
  post = <T>(p: string, b?: unknown) => this.request<T>('POST', p, b ?? {});
  put = <T>(p: string, b: unknown) => this.request<T>('PUT', p, b);
  patch = <T>(p: string, b: unknown) => this.request<T>('PATCH', p, b);
  del = <T>(p: string) => this.request<T>('DELETE', p);

  onMessage(fn: (m: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnection(fn: (c: boolean) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  connect(): void {
    if (this.closed) return;
    const wsUrl = `${this.conn.url.replace(/^http/, 'ws')}/events?token=${encodeURIComponent(this.conn.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      for (const l of this.stateListeners) l(true);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      for (const l of this.listeners) l(m);
    };
    ws.onclose = () => {
      this.connected = false;
      for (const l of this.stateListeners) l(false);
      if (this.closed) return;
      setTimeout(async () => {
        if (this.resolver) {
          try {
            this.conn = await this.resolver();
          } catch {
            /* keep previous connection details and retry */
          }
        }
        this.connect();
      }, 1500);
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
