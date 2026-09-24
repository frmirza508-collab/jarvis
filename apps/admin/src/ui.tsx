import { useCallback, useEffect, useState, type ReactNode } from 'react';

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

export function Status({ value }: { value: string }) {
  return <span className={`badge badge-${value}`}>{value.replace('_', ' ')}</span>;
}

export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <div className="actions">{actions}</div>
      </header>
      {children}
    </section>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}

export function SearchBar({
  onSearch,
  placeholder,
  children,
}: {
  onSearch: (q: string) => void;
  placeholder: string;
  children?: ReactNode;
}) {
  const [q, setQ] = useState('');
  return (
    <form
      className="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(q);
      }}
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {children}
      <button type="submit">Search</button>
    </form>
  );
}

/** Runs an admin action with confirmation and a reason prompt. */
export async function confirmAction(
  message: string,
  run: (reason?: string) => Promise<unknown>,
  askReason = false,
): Promise<boolean> {
  if (!window.confirm(message)) return false;
  const reason = askReason ? (window.prompt('Reason (recorded in audit log):') ?? undefined) : undefined;
  try {
    await run(reason);
    return true;
  } catch (e) {
    window.alert((e as Error).message);
    return false;
  }
}
