import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../lib/store';
import type { NodeState } from '../lib/types';
import { STATUS_COLORS, TASK_CENTER, departmentPosition } from './layout';

/** Lays out a DAG by dependency depth. */
export function layoutGraph(nodes: NodeState[]): Map<string, THREE.Vector3> {
  const depth = new Map<string, number>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const d = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = byId.get(id);
    const v = n && n.dependsOn.length ? 1 + Math.max(...n.dependsOn.map((x) => d(x, seen))) : 0;
    depth.set(id, v);
    return v;
  };
  nodes.forEach((n) => d(n.id));
  const levels = new Map<number, string[]>();
  for (const [id, lv] of depth) levels.set(lv, [...(levels.get(lv) ?? []), id]);
  const maxLevel = Math.max(0, ...levels.keys());
  const pos = new Map<string, THREE.Vector3>();
  for (const [lv, ids] of levels)
    ids.forEach((id, i) => pos.set(id, TASK_CENTER.clone().add(new THREE.Vector3((lv - maxLevel / 2) * 2.4, 0, (i - (ids.length - 1) / 2) * 1.6))));
  return pos;
}

export function TaskGraph3D() {
  const live = useStore((s) => s.live);
  const agents = useStore((s) => s.agents);
  const req = Object.values(live).at(-1);
  const nodes = useMemo(() => Object.values(req?.nodes ?? {}), [req]);
  const pos = useMemo(() => layoutGraph(nodes), [nodes]);
  if (!req) return null;
  if (!nodes.length) return <PlanningBeacon />;
  return (
    <group>
      {nodes.map((n) =>
        n.dependsOn.map((dep) => {
          const a = pos.get(dep);
          const b = pos.get(n.id);
          return a && b ? <Line key={`${dep}-${n.id}`} points={[a.toArray(), b.toArray()]} color={STATUS_COLORS[n.status] ?? '#56627f'} lineWidth={1.5} transparent opacity={0.8} /> : null;
        }),
      )}
      {nodes.map((n) => {
        const p = pos.get(n.id)!;
        const dept = n.assignee ? agents[n.assignee]?.department : undefined;
        return (
          <group key={n.id}>
            {dept && n.status === 'running' && <Line points={[p.toArray(), departmentPosition(dept).toArray()]} color="#37c6ff" dashed dashSize={0.3} gapSize={0.2} lineWidth={1} transparent opacity={0.6} />}
            <TaskNode node={n} position={p} agentName={n.assignee ? (agents[n.assignee]?.name ?? n.assignee) : ''} />
          </group>
        );
      })}
    </group>
  );
}

function TaskNode({ node, position, agentName }: { node: NodeState; position: THREE.Vector3; agentName: string }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((st, dt) => {
    if (!ref.current) return;
    ref.current.rotation.y += dt * (node.status === 'running' ? 2 : 0.2);
    ref.current.scale.setScalar(node.status === 'running' ? 1 + Math.sin(st.clock.elapsedTime * 6) * 0.12 : 1);
  });
  const c = STATUS_COLORS[node.status] ?? '#56627f';
  return (
    <group position={position}>
      <mesh ref={ref}>
        <boxGeometry args={[0.55, 0.55, 0.55]} />
        <meshStandardMaterial color={c} emissive={c} emissiveIntensity={node.status === 'running' ? 2 : 0.6} transparent opacity={0.9} />
      </mesh>
      <Html center distanceFactor={10} position={[0, 0.75, 0]} className="label3d task">
        <b>{agentName}</b>
        <span>{node.label.slice(0, 60)}</span>
        <small>{node.status}{node.attempts > 1 ? ` · attempt ${node.attempts}` : ''}</small>
      </Html>
    </group>
  );
}

function PlanningBeacon() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((st) => ref.current && ref.current.scale.setScalar(1 + Math.sin(st.clock.elapsedTime * 5) * 0.2));
  return (
    <group position={TASK_CENTER}>
      <mesh ref={ref}>
        <torusKnotGeometry args={[0.5, 0.12, 96, 12]} />
        <meshStandardMaterial color="#c7a6ff" emissive="#c7a6ff" emissiveIntensity={1.5} wireframe />
      </mesh>
      <Html center distanceFactor={10} position={[0, 1.1, 0]} className="label3d">planning…</Html>
    </group>
  );
}
