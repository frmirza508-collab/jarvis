import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../lib/store';
import { voiceEngine } from '../voice-ui/voice-controller';

const STATE_COLORS: Record<string, string> = {
  idle: '#37c6ff',
  listening: '#5cffc8',
  transcribing: '#ffe066',
  thinking: '#c7a6ff',
  speaking: '#ffffff',
};

/** Central JARVIS core: layered energy shells, orbiting rings and a voice field. */
export function JarvisCore({ busy }: { busy: boolean }) {
  const group = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Mesh>(null);
  const shell = useRef<THREE.Mesh>(null);
  const rings = useRef<THREE.Group>(null);
  const voice = useStore((s) => s.voice);
  const reduced = useStore((s) => s.prefs.reducedMotion);
  const color = useMemo(() => new THREE.Color(STATE_COLORS[voice.state] ?? '#37c6ff'), [voice.state]);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const speed = reduced ? 0 : 1;
    const pulse = 1 + (reduced ? 0 : Math.sin(t * (busy ? 4 : 1.6)) * 0.035) + voice.level * 0.25;
    inner.current?.scale.setScalar(pulse);
    if (shell.current) {
      shell.current.rotation.y += dt * 0.2 * speed;
      shell.current.rotation.x += dt * 0.07 * speed;
      (shell.current.material as THREE.MeshBasicMaterial).color.lerp(color, 0.08);
    }
    if (inner.current) (inner.current.material as THREE.MeshStandardMaterial).emissive.lerp(color, 0.08);
    if (rings.current)
      rings.current.children.forEach(
        (r, i) => (r.rotation.z += dt * (0.3 + i * 0.15) * (busy ? 2.5 : 1) * speed * (i % 2 ? -1 : 1)),
      );
    if (group.current && !reduced) group.current.position.y = Math.sin(t * 0.8) * 0.08;
  });

  return (
    <group ref={group}>
      <mesh ref={inner}>
        <icosahedronGeometry args={[0.9, 5]} />
        <meshStandardMaterial
          color="#0a1a33"
          emissive="#37c6ff"
          emissiveIntensity={1.6}
          roughness={0.25}
          metalness={0.4}
        />
      </mesh>
      <mesh ref={shell}>
        <icosahedronGeometry args={[1.35, 2]} />
        <meshBasicMaterial color="#37c6ff" wireframe transparent opacity={0.28} />
      </mesh>
      <mesh>
        <sphereGeometry args={[1.8, 32, 32]} />
        <meshBasicMaterial
          color="#1b6dff"
          transparent
          opacity={0.06}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <group ref={rings}>
        {[2.1, 2.5, 2.9].map((r, i) => (
          <mesh key={r} rotation={[Math.PI / 2 + i * 0.35, i * 0.6, 0]}>
            <torusGeometry args={[r, 0.012, 8, 160]} />
            <meshBasicMaterial
              color={i === 1 ? '#7fe3ff' : '#37c6ff'}
              transparent
              opacity={0.55}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        ))}
      </group>
      <VoiceField />
      <pointLight color="#37c6ff" intensity={30} distance={12} />
    </group>
  );
}

/** Ring of bars driven by the live microphone waveform / output level. */
function VoiceField() {
  const N = 96;
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const level = useStore((s) => s.voice.level);
  const vstate = useStore((s) => s.voice.state);
  useFrame((state) => {
    if (!mesh.current) return;
    const wf = voiceEngine().waveform;
    const t = state.clock.elapsedTime;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const sample = wf.length ? Math.abs((wf[Math.floor((i / N) * wf.length)] ?? 128) - 128) / 128 : 0;
      const speakingWave = vstate === 'speaking' ? (Math.sin(t * 9 + i * 0.5) * 0.5 + 0.5) * 0.6 : 0;
      const h = 0.04 + sample * 2.2 + level * 0.6 + speakingWave;
      dummy.position.set(Math.cos(a) * 2.35, 0, Math.sin(a) * 2.35);
      dummy.scale.set(1, h, 1);
      dummy.lookAt(0, 0, 0);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]} rotation={[0, 0, 0]}>
      <boxGeometry args={[0.03, 0.5, 0.03]} />
      <meshBasicMaterial color="#9ff0ff" transparent opacity={0.8} blending={THREE.AdditiveBlending} />
    </instancedMesh>
  );
}

/** Swirling energy particles (instanced meshes work on WebGL and WebGPU alike). */
export function EnergyParticles({ count, busy }: { count: number; busy: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const reduced = useStore((s) => s.prefs.reducedMotion);
  const seeds = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        r: 2.6 + Math.random() * 9,
        a: Math.random() * Math.PI * 2,
        y: (Math.random() - 0.5) * 5,
        s: 0.02 + Math.random() * 0.08,
        size: 0.01 + Math.random() * 0.03,
      })),
    [count],
  );
  useFrame((_, dt) => {
    if (!mesh.current) return;
    const k = reduced ? 0 : busy ? 3 : 1;
    seeds.forEach((p, i) => {
      p.a += dt * p.s * k * (8 / p.r);
      dummy.position.set(Math.cos(p.a) * p.r, p.y + Math.sin(p.a * 2) * 0.3, Math.sin(p.a) * p.r);
      dummy.scale.setScalar(p.size * 10);
      dummy.updateMatrix();
      mesh.current!.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]}>
      <octahedronGeometry args={[0.1, 0]} />
      <meshBasicMaterial
        color="#6fd8ff"
        transparent
        opacity={0.7}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </instancedMesh>
  );
}
