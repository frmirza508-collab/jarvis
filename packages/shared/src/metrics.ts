/** Real operational metrics (no invented scores). */
export interface OperationalMetrics {
  tasksStarted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  toolErrors: number;
  reviewCorrections: number;
  totalLatencyMs: number;
  lastActiveAt?: string;
}

export const emptyMetrics = (): OperationalMetrics => ({
  tasksStarted: 0,
  tasksSucceeded: 0,
  tasksFailed: 0,
  toolErrors: 0,
  reviewCorrections: 0,
  totalLatencyMs: 0,
});

export function successRate(m: OperationalMetrics): number | null {
  const done = m.tasksSucceeded + m.tasksFailed;
  return done === 0 ? null : m.tasksSucceeded / done;
}

export function avgLatencyMs(m: OperationalMetrics): number | null {
  const done = m.tasksSucceeded + m.tasksFailed;
  return done === 0 ? null : m.totalLatencyMs / done;
}
