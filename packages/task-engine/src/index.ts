import { JarvisError, newId, toJarvisError } from '@jarvis/shared';

export type NodeStatus = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface TaskNode<TOut = unknown> {
  id: string;
  label: string;
  /** Agent or skill that will execute the node. */
  assignee?: string;
  dependsOn: string[];
  run: (ctx: NodeContext) => Promise<TOut>;
  retries?: number;
  timeoutMs?: number;
  /** If true, failure of this node does not fail the graph (dependents are skipped). */
  optional?: boolean;
}

export interface NodeContext {
  signal: AbortSignal;
  /** Outputs of completed dependencies, by node id. */
  inputs: Record<string, unknown>;
  attempt: number;
  progress: (message: string, percent?: number) => void;
}

export interface NodeState {
  id: string;
  label: string;
  assignee?: string;
  dependsOn: string[];
  status: NodeStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  output?: unknown;
  error?: string;
}

export type GraphEvent =
  | { kind: 'node'; graphId: string; node: NodeState }
  | { kind: 'progress'; graphId: string; nodeId: string; message: string; percent?: number }
  | { kind: 'graph'; graphId: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled' };

export interface GraphResult {
  graphId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  nodes: Record<string, NodeState>;
}

/** Validates the graph is acyclic and all dependencies exist. Returns a topological order. */
export function topoSort(nodes: Pick<TaskNode, 'id' | 'dependsOn'>[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) throw new JarvisError('INVALID_INPUT', 'Duplicate node ids in task graph');
  for (const n of nodes)
    for (const d of n.dependsOn)
      if (!ids.has(d)) throw new JarvisError('INVALID_INPUT', `Node ${n.id} depends on unknown node ${d}`);
  const indeg = new Map(nodes.map((n) => [n.id, n.dependsOn.length]));
  const order: string[] = [];
  const queue = nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const n of nodes)
      if (n.dependsOn.includes(id)) {
        indeg.set(n.id, indeg.get(n.id)! - 1);
        if (indeg.get(n.id) === 0) queue.push(n.id);
      }
  }
  if (order.length !== nodes.length) throw new JarvisError('INVALID_INPUT', 'Task graph contains a cycle');
  return order;
}

function withTimeout<T>(p: Promise<T>, ms: number | undefined, signal: AbortSignal): Promise<T> {
  if (!ms) return p;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new JarvisError('TIMEOUT', `Timed out after ${ms}ms`)), ms);
    signal.addEventListener('abort', () => clearTimeout(t));
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * DAG executor: runs independent nodes in parallel (bounded concurrency),
 * retries failed nodes, supports cancellation, and streams state changes.
 */
export class TaskGraph {
  readonly id: string;
  private readonly states = new Map<string, NodeState>();
  private readonly defs = new Map<string, TaskNode>();
  private readonly controller = new AbortController();

  constructor(
    nodes: TaskNode[],
    private readonly opts: { concurrency?: number; onEvent?: (e: GraphEvent) => void; id?: string } = {},
  ) {
    topoSort(nodes);
    this.id = opts.id ?? newId('graph');
    for (const n of nodes) {
      this.defs.set(n.id, n);
      this.states.set(n.id, {
        id: n.id,
        label: n.label,
        assignee: n.assignee,
        dependsOn: n.dependsOn,
        status: 'pending',
        attempts: 0,
      });
    }
  }

  snapshot(): NodeState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  cancel(): void {
    this.controller.abort();
  }

  private set(id: string, patch: Partial<NodeState>): void {
    const s = { ...this.states.get(id)!, ...patch };
    this.states.set(id, s);
    this.opts.onEvent?.({ kind: 'node', graphId: this.id, node: { ...s } });
  }

  async run(): Promise<GraphResult> {
    const concurrency = Math.max(1, this.opts.concurrency ?? 4);
    const signal = this.controller.signal;
    this.opts.onEvent?.({ kind: 'graph', graphId: this.id, status: 'running' });
    const running = new Map<string, Promise<void>>();
    let failedRequired = false;

    const isTerminal = (s: NodeStatus) => ['succeeded', 'failed', 'skipped', 'cancelled'].includes(s);

    const startNode = (id: string): Promise<void> => {
      const def = this.defs.get(id)!;
      const inputs: Record<string, unknown> = {};
      for (const d of def.dependsOn) inputs[d] = this.states.get(d)!.output;
      return (async () => {
        const maxAttempts = 1 + (def.retries ?? 0);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          this.set(id, { status: 'running', attempts: attempt, startedAt: Date.now() });
          try {
            const out = await withTimeout(
              def.run({
                signal,
                inputs,
                attempt,
                progress: (message, percent) =>
                  this.opts.onEvent?.({ kind: 'progress', graphId: this.id, nodeId: id, message, percent }),
              }),
              def.timeoutMs,
              signal,
            );
            if (signal.aborted) throw new JarvisError('CANCELLED', 'Cancelled');
            this.set(id, { status: 'succeeded', output: out, finishedAt: Date.now(), error: undefined });
            return;
          } catch (e) {
            const je = toJarvisError(e);
            if (signal.aborted || je.code === 'CANCELLED') {
              this.set(id, { status: 'cancelled', error: je.message, finishedAt: Date.now() });
              return;
            }
            if (attempt === maxAttempts) {
              this.set(id, { status: 'failed', error: je.message, finishedAt: Date.now() });
              if (!def.optional) failedRequired = true;
              return;
            }
          }
        }
      })();
    };

    while (true) {
      if (signal.aborted) break;
      // Skip nodes whose dependencies failed/skipped/cancelled.
      for (const s of this.states.values()) {
        if (s.status !== 'pending') continue;
        const deps = s.dependsOn.map((d) => this.states.get(d)!.status);
        if (deps.some((d) => d === 'failed' || d === 'skipped' || d === 'cancelled'))
          this.set(s.id, { status: 'skipped', error: 'dependency did not succeed' });
      }
      if (failedRequired) break;
      const ready = [...this.states.values()].filter(
        (s) => s.status === 'pending' && s.dependsOn.every((d) => this.states.get(d)!.status === 'succeeded'),
      );
      for (const s of ready) {
        if (running.size >= concurrency) break;
        const p = startNode(s.id).finally(() => running.delete(s.id));
        running.set(s.id, p);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());

    for (const s of this.states.values())
      if (!isTerminal(s.status)) this.set(s.id, { status: signal.aborted ? 'cancelled' : 'skipped' });

    const status: GraphResult['status'] = signal.aborted
      ? 'cancelled'
      : failedRequired
        ? 'failed'
        : 'succeeded';
    this.opts.onEvent?.({ kind: 'graph', graphId: this.id, status });
    return {
      graphId: this.id,
      status,
      nodes: Object.fromEntries([...this.states].map(([k, v]) => [k, { ...v }])),
    };
  }
}
