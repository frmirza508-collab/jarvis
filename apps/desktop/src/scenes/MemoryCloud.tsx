import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { core } from '../lib/actions';
import { useStore } from '../lib/store';
import type { MemoryItem } from '../lib/types';
import { MEMORY_CENTER } from './layout';

const SCOPE_COLORS: Record<string, string> = {
  preference: '#ff7ad9',
  project: '#4f9dff',
  knowledge: '#5cffc8',
  lesson: '#ffe066',
  agent: '#c7a6ff',
  global: '#7fe3ff',
  session: '#56627f',
  task: '#9cff6b',
  department: '#ffb35c',
};

/** Knowledge/memory visualisation: each stored memory is a node, grouped by scope. */
export function MemoryCloud() {
  const view = useStore((s) => s.view);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [hover, setHover] = useState<MemoryItem | null>(null);
  const group = useRef<THREE.Group>(null);
  const reduced = useStore((s) => s.prefs.reducedMotion);
  useEffect(() => {
    if (view !== 'memory') return;
    void core()
      .get<MemoryItem[]>('/memory')
      .then(setItems)
      .catch(() => setItems([]));
  }, [view]);
  const positions = useMemo(() => {
    const scopes = [...new Set(items.map((i) => i.scope))];
    return items.map((it, i) => {
      const si = scopes.indexOf(it.scope);
      const a = (si / Math.max(1, scopes.length)) * Math.PI * 2;
      const center = new THREE.Vector3(Math.cos(a) * 3, Math.sin(a * 1.5) * 1.2, Math.sin(a) * 3);
      const phi = Math.acos(1 - (2 * (i + 0.5)) / Math.max(1, items.length));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      return center.add(
        new THREE.Vector3(
          Math.cos(theta) * Math.sin(phi),
          Math.cos(phi),
          Math.sin(theta) * Math.sin(phi),
        ).multiplyScalar(1.2),
      );
    });
  }, [items]);
  useFrame((_, dt) => {
    if (group.current && !reduced) group.current.rotation.y += dt * 0.08;
  });
  return (
    <group position={MEMORY_CENTER}>
      <group ref={group}>
        {items.map((it, i) => (
          <mesh
            key={it.id}
            position={positions[i]}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHover(it);
            }}
            onPointerOut={() => setHover(null)}
          >
            <sphereGeometry args={[it.verified ? 0.16 : 0.1, 12, 12]} />
            <meshStandardMaterial
              color={SCOPE_COLORS[it.scope] ?? '#7fe3ff'}
              emissive={SCOPE_COLORS[it.scope] ?? '#7fe3ff'}
              emissiveIntensity={it.verified ? 2 : 0.8}
            />
          </mesh>
        ))}
        {hover && (
          <Html
            center
            distanceFactor={10}
            position={positions[items.indexOf(hover)]?.clone().add(new THREE.Vector3(0, 0.4, 0))}
            className="label3d"
          >
            <b>{hover.scope}</b> {hover.content.slice(0, 90)}
          </Html>
        )}
      </group>
      <mesh>
        <sphereGeometry args={[5, 24, 24]} />
        <meshBasicMaterial color="#5cffc8" wireframe transparent opacity={0.04} />
      </mesh>
      {items.length === 0 && view === 'memory' && (
        <Html center className="label3d">
          No memories stored yet
        </Html>
      )}
    </group>
  );
}
