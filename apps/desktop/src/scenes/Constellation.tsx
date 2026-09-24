import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../lib/store';
import { go } from '../lib/actions';
import { agentPosition, DEPARTMENTS, DEPT_COLORS, departmentPosition } from './layout';
import type { AgentInfo } from '../lib/types';

const HEALTH_COLORS: Record<string, string> = { busy: '#ffffff', degraded: '#ff5a6e', disabled: '#3a4058' };

/** 3D agent organisation: department hubs orbiting the core, specialists orbiting hubs. */
export function Constellation({ showLabels }: { showLabels: boolean }) {
  const agents = useStore((s) => s.agents);
  const selectedAgent = useStore((s) => s.selectedAgent);
  const selectedDept = useStore((s) => s.selectedDepartment);
  const byDept = useMemo(() => {
    const m = new Map<string, AgentInfo[]>();
    for (const a of Object.values(agents)) m.set(a.department, [...(m.get(a.department) ?? []), a]);
    for (const list of m.values()) list.sort((a, b) => a.id.localeCompare(b.id));
    return m;
  }, [agents]);

  return (
    <group>
      {DEPARTMENTS.map((d) => {
        const hub = departmentPosition(d);
        const list = byDept.get(d) ?? [];
        const active = list.some((a) => a.health.state === 'busy');
        return (
          <group key={d}>
            <Line points={[[0, 0, 0], hub.toArray()]} color={DEPT_COLORS[d]} lineWidth={active ? 2 : 1} transparent opacity={active ? 0.9 : 0.25} />
            <DepartmentHub dept={d} position={hub} active={active} selected={selectedDept === d} count={list.length} showLabel={showLabels} />
            {list.map((a, i) => (
              <AgentNode key={a.id} agent={a} position={agentPosition(d, i, list.length)} hub={hub} selected={selectedAgent === a.id} />
            ))}
          </group>
        );
      })}
    </group>
  );
}

function DepartmentHub({ dept, position, active, selected, count, showLabel }: { dept: string; position: THREE.Vector3; active: boolean; selected: boolean; count: number; showLabel: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const [hover, setHover] = useState(false);
  const reduced = useStore((s) => s.prefs.reducedMotion);
  useFrame((st, dt) => {
    if (!ref.current) return;
    if (!reduced) ref.current.rotation.y += dt * (active ? 1.5 : 0.3);
    ref.current.scale.setScalar(hover || selected ? 1.3 : 1);
  });
  return (
    <group position={position}>
      <mesh
        ref={ref}
        onClick={(e) => {
          e.stopPropagation();
          go('departments', { department: dept });
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHover(false);
          document.body.style.cursor = '';
        }}
      >
        <octahedronGeometry args={[0.45, 0]} />
        <meshStandardMaterial color={DEPT_COLORS[dept]} emissive={DEPT_COLORS[dept]} emissiveIntensity={active ? 2.2 : 0.7} wireframe={!active} />
      </mesh>
      {(showLabel || hover || selected) && (
        <Html center distanceFactor={14} position={[0, 0.9, 0]} className="label3d">
          <span style={{ color: DEPT_COLORS[dept] }}>{dept}</span> <small>{count}</small>
        </Html>
      )}
    </group>
  );
}

function AgentNode({ agent, position, hub, selected }: { agent: AgentInfo; position: THREE.Vector3; hub: THREE.Vector3; selected: boolean }) {
  const [hover, setHover] = useState(false);
  const ref = useRef<THREE.Mesh>(null);
  const color = HEALTH_COLORS[agent.health.state] ?? DEPT_COLORS[agent.department] ?? '#7fe3ff';
  const busy = agent.health.state === 'busy';
  useFrame((st) => {
    if (!ref.current) return;
    const s = (busy ? 1.4 + Math.sin(st.clock.elapsedTime * 8) * 0.25 : 1) * (hover || selected ? 1.6 : 1);
    ref.current.scale.setScalar(s);
  });
  return (
    <group>
      <Line points={[hub.toArray(), position.toArray()]} color={DEPT_COLORS[agent.department]} transparent opacity={busy ? 0.8 : 0.15} lineWidth={1} />
      <mesh
        ref={ref}
        position={position}
        onClick={(e) => {
          e.stopPropagation();
          go('agents', { agent: agent.id });
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <sphereGeometry args={[0.13, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={busy ? 3 : agent.health.state === 'disabled' ? 0.1 : 0.8} />
      </mesh>
      {(hover || selected) && (
        <Html center distanceFactor={12} position={position.clone().add(new THREE.Vector3(0, 0.45, 0))} className="label3d">
          {agent.name}
          <small> · {agent.health.state}</small>
        </Html>
      )}
    </group>
  );
}
