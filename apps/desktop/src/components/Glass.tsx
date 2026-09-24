import type { ReactNode } from 'react';

/** Floating holographic glass panel (dense info stays readable in 2D). */
export function Glass({
  title,
  children,
  className = '',
  actions,
  tilt = 'none',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  tilt?: 'left' | 'right' | 'none';
}) {
  return (
    <section className={`glass tilt-${tilt} ${className}`} aria-label={title}>
      {title && (
        <header>
          <h2>{title}</h2>
          <div className="glass-actions">{actions}</div>
        </header>
      )}
      <div className="glass-body">{children}</div>
    </section>
  );
}

export function StateBadge({ state }: { state: string }) {
  return <span className={`state state-${state}`}>{state.replace(/_/g, ' ')}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
