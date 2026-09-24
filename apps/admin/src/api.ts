export const API_URL: string = (import.meta.env.VITE_LICENSE_API_URL as string | undefined) ?? 'http://localhost:8787';

const TOKEN_KEY = 'jarvis-admin-token';
export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event('jarvis-logout'));
  }
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Request failed (${res.status})`);
  return data as T;
}

export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleString() : '—');
export const fmtMoney = (amount: number, currency: string) => `${Number(amount).toLocaleString('en-PK')} ${currency}`;
