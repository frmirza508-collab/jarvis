import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerformanceMonitor, Stars } from '@react-three/drei';
import * as THREE from 'three';
import { getState, setState, useStore, type Prefs } from '../lib/store';
import { CAMERA } from './layout';
import { EnergyParticles, JarvisCore } from './Core';
import { Constellation } from './Constellation';
import { TaskGraph3D } from './TaskGraph3D';
import { Modules3D } from './Modules3D';
import { MemoryCloud } from './MemoryCloud';

type RendererProps = {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  antialias?: boolean;
  powerPreference?: string;
  alpha?: boolean;
};

/**
 * Renderer selection: WebGPU when available and requested ("auto"), otherwise
 * WebGL2. Any WebGPU initialisation failure falls back to WebGL transparently.
 */
async function createRenderer(props: RendererProps, prefs: Prefs): Promise<THREE.WebGLRenderer> {
  // WebGPU is opt-in: drei helpers used in the scene (Stars, Line) rely on GLSL shaders that
  // WebGPURenderer cannot draw, which left the scene black on real WebView2 installs.
  const wantGpu = prefs.renderer === 'webgpu' && typeof navigator !== 'undefined' && 'gpu' in navigator;
  if (wantGpu) {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
      if (!gpu || !(await gpu.requestAdapter())) throw new Error('no adapter');
      const mod = await import('three/webgpu');
      const r = new mod.WebGPURenderer({
        canvas: props.canvas as HTMLCanvasElement,
        antialias: prefs.quality !== 'low',
        powerPreference: 'high-performance',
      });
      await r.init();
      setState({ rendererKind: 'webgpu' });
      return r as unknown as THREE.WebGLRenderer;
    } catch {
      /* fall through to WebGL */
    }
  }
  const r = new THREE.WebGLRenderer({
    canvas: props.canvas as HTMLCanvasElement,
    antialias: prefs.quality !== 'low',
    powerPreference: 'high-performance',
    alpha: false,
  });
  setState({ rendererKind: 'webgl' });
  return r;
}

function CameraRig() {
  const view = useStore((s) => s.view);
  const reduced = useStore((s) => s.prefs.reducedMotion);
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3());
  const flying = useRef(true);
  useEffect(() => {
    flying.current = true;
  }, [view]);
  useFrame((_, dt) => {
    const [pos, look] = CAMERA[view];
    if (flying.current) {
      const k = reduced ? 1 : 1 - Math.pow(0.02, dt);
      camera.position.lerp(pos, k);
      target.current.lerp(look, k);
      controls.current?.target.copy(target.current);
      if (camera.position.distanceTo(pos) < 0.05) flying.current = false;
    }
    controls.current?.update();
  });
  return (
    <OrbitControls
      ref={controls}
      enableDamping
      dampingFactor={0.08}
      minDistance={3}
      maxDistance={45}
      onStart={() => {
        flying.current = false;
      }}
    />
  );
}

function FpsMeter() {
  const acc = useRef({ t: 0, n: 0 });
  useFrame((_, dt) => {
    acc.current.t += dt;
    acc.current.n++;
    if (acc.current.t >= 1) {
      setState({ fps: Math.round(acc.current.n / acc.current.t) });
      acc.current = { t: 0, n: 0 };
    }
  });
  return null;
}

export function World() {
  const prefs = useStore((s) => s.prefs);
  const live = useStore((s) => s.live);
  const view = useStore((s) => s.view);
  const busy = Object.keys(live).length > 0;
  const dpr: [number, number] =
    prefs.quality === 'high' ? [1, 2] : prefs.quality === 'medium' ? [1, 1.5] : [0.75, 1];
  const particles = prefs.quality === 'high' ? 1400 : prefs.quality === 'medium' ? 700 : 250;
  const showLabels = view === 'agents' || view === 'departments' || view === 'modules';
  const glFactory = useMemo(() => (props: RendererProps) => createRenderer(props, getState().prefs), []);

  return (
    <Canvas
      className="world"
      dpr={dpr}
      camera={{ position: [0, 2.2, 14], fov: 50, near: 0.1, far: 300 }}
      gl={glFactory as never}
      onCreated={({ gl }) => gl.setClearColor('#03050c')}
      frameloop="always"
      aria-label="JARVIS 3D command space"
    >
      <PerformanceMonitor
        onDecline={() => {
          const q = getState().prefs.quality;
          if (q !== 'low')
            setState({ prefs: { ...getState().prefs, quality: q === 'high' ? 'medium' : 'low' } });
        }}
      />
      <FpsMeter />
      <fog attach="fog" args={['#03050c', 18, 70]} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[5, 10, 5]} intensity={0.6} color="#9fd8ff" />
      <Suspense fallback={null}>
        <Stars
          radius={90}
          depth={40}
          count={prefs.quality === 'low' ? 1500 : 4000}
          factor={3}
          saturation={0}
          fade
          speed={prefs.reducedMotion ? 0 : 0.6}
        />
        <JarvisCore busy={busy} />
        <EnergyParticles count={particles} busy={busy} />
        <Constellation showLabels={showLabels} />
        <TaskGraph3D />
        <Modules3D showLabels={showLabels} />
        <MemoryCloud />
        <gridHelper args={[60, 60, '#123a5c', '#0b1c30']} position={[0, -5, 0]} />
      </Suspense>
      <CameraRig />
    </Canvas>
  );
}
