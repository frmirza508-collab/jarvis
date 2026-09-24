import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type * as THREE from 'three';
import { useStore } from '../lib/store';
import { go } from '../lib/actions';
import { MODULES, modulePosition } from './layout';

const STATE_COLORS: Record<string, string> = {
  active: '#37c6ff',
  degraded: '#ffb547',
  not_configured: '#ffb547',
  unsupported: '#4a5070',
  disabled: '#4a5070',
  planned: '#4a5070',
};

export function moduleState(id: string, caps: Array<{ id: string; state: string }> | undefined): string {
  if (!caps) return 'planned';
  if (id === 'voice') return caps.find((c) => c.id === 'voice.stt')?.state ?? 'planned';
  if (id === 'models') return caps.find((c) => c.id === 'models')?.state ?? 'planned';
  return caps.find((c) => c.id === `module.${id}`)?.state ?? 'planned';
}

/** Functional modules as stations beneath the core; colour = honest capability state. */
export function Modules3D({ showLabels }: { showLabels: boolean }) {
  const caps = useStore((s) => s.status?.capabilities);
  return (
    <group>
      {MODULES.map((m, i) => (
        <ModuleStation
          key={m}
          id={m}
          position={modulePosition(i, MODULES.length)}
          state={moduleState(m, caps)}
          showLabel={showLabels}
        />
      ))}
    </group>
  );
}

function ModuleStation({
  id,
  position,
  state,
  showLabel,
}: {
  id: string;
  position: THREE.Vector3;
  state: string;
  showLabel: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const reduced = useStore((s) => s.prefs.reducedMotion);
  useFrame((_, dt) => {
    if (ref.current && !reduced && state === 'active') ref.current.rotation.y += dt * 0.6;
  });
  const c = STATE_COLORS[state] ?? '#4a5070';
  return (
    <group position={position}>
      <group
        ref={ref}
        onClick={(e) => {
          e.stopPropagation();
          go('modules');
        }}
        onPointerOver={() => setHover(true)}
        onPointerOut={() => setHover(false)}
      >
        <mesh>
          <cylinderGeometry args={[0.55, 0.7, 0.18, 6]} />
          <meshStandardMaterial
            color={c}
            emissive={c}
            emissiveIntensity={state === 'active' ? 1.2 : 0.2}
            metalness={0.6}
            roughness={0.3}
          />
        </mesh>
        <mesh position={[0, 0.45, 0]}>
          <octahedronGeometry args={[0.22, 0]} />
          <meshStandardMaterial
            color={c}
            emissive={c}
            emissiveIntensity={state === 'active' ? 2 : 0.3}
            wireframe={state !== 'active'}
          />
        </mesh>
      </group>
      {(showLabel || hover) && (
        <Html center distanceFactor={12} position={[0, 1.1, 0]} className="label3d">
          {id} <small>{state.replace('_', ' ')}</small>
        </Html>
      )}
    </group>
  );
}
