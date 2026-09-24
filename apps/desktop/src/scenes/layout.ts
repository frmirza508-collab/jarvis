import * as THREE from 'three';
import type { ViewId } from '../lib/store';

export const DEPARTMENTS = [
  'executive',
  'engineering',
  'research',
  'design',
  'marketing',
  'business',
  'security',
  'knowledge-ai',
  'qa-operations',
] as const;

export const DEPT_COLORS: Record<string, string> = {
  executive: '#7fe3ff',
  engineering: '#4f9dff',
  research: '#5cffc8',
  design: '#ff7ad9',
  marketing: '#ffb35c',
  business: '#c7a6ff',
  security: '#ff5f6d',
  'knowledge-ai': '#ffe066',
  'qa-operations': '#9cff6b',
};

const RING = 9;
export function departmentPosition(dept: string): THREE.Vector3 {
  const i = Math.max(0, DEPARTMENTS.indexOf(dept as (typeof DEPARTMENTS)[number]));
  const a = (i / DEPARTMENTS.length) * Math.PI * 2;
  return new THREE.Vector3(Math.cos(a) * RING, Math.sin(a * 2) * 0.8, Math.sin(a) * RING);
}

export function agentPosition(dept: string, index: number, count: number): THREE.Vector3 {
  const hub = departmentPosition(dept);
  const a = (index / Math.max(1, count)) * Math.PI * 2;
  const r = 1.4 + (count > 12 ? (index % 2) * 0.6 : 0);
  return hub
    .clone()
    .add(
      new THREE.Vector3(Math.cos(a) * r, Math.sin(a * 3) * 0.35 + ((index % 3) - 1) * 0.25, Math.sin(a) * r),
    );
}

export const MODULES = [
  'file-system',
  'terminal',
  'browser-control',
  'documents',
  'web-research',
  'computer-control',
  'memory',
  'voice',
  'models',
] as const;
export function modulePosition(i: number, n: number): THREE.Vector3 {
  const a = (i / n) * Math.PI * 2 + Math.PI / n;
  return new THREE.Vector3(Math.cos(a) * 5.5, -4.2, Math.sin(a) * 5.5);
}

export const MEMORY_CENTER = new THREE.Vector3(0, 1, -22);
export const TASK_CENTER = new THREE.Vector3(0, 6.5, 0);

/** Camera placement per view: [position, target]. */
export const CAMERA: Record<ViewId, [THREE.Vector3, THREE.Vector3]> = {
  command: [new THREE.Vector3(0, 2.2, 11), new THREE.Vector3(0, 0.6, 0)],
  voice: [new THREE.Vector3(0, 1.5, 6.5), new THREE.Vector3(0, 0.2, 0)],
  agents: [new THREE.Vector3(0, 16, 17), new THREE.Vector3(0, 0, 0)],
  departments: [new THREE.Vector3(0, 12, 18), new THREE.Vector3(0, 0, 0)],
  tasks: [new THREE.Vector3(0, 8.5, 9), new THREE.Vector3(0, 6, 0)],
  modules: [new THREE.Vector3(0, -1.2, 11), new THREE.Vector3(0, -4, 0)],
  memory: [new THREE.Vector3(0, 3, -12), new THREE.Vector3(0, 1, -22)],
  system: [new THREE.Vector3(8, 4, 8), new THREE.Vector3(0, 0, 0)],
  settings: [new THREE.Vector3(-9, 3, 7), new THREE.Vector3(0, 0, 0)],
  account: [new THREE.Vector3(-6, 1.5, 8), new THREE.Vector3(0, 0.5, 0)],
  activity: [new THREE.Vector3(9, 6, -4), new THREE.Vector3(0, 0, 0)],
};

export const STATUS_COLORS: Record<string, string> = {
  pending: '#56627f',
  ready: '#7c8bb5',
  running: '#37c6ff',
  succeeded: '#3ddc97',
  failed: '#ff5a6e',
  skipped: '#8a7c5a',
  cancelled: '#6b6f80',
};
