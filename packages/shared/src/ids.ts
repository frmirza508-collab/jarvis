import { randomUUID } from 'node:crypto';

export type Id = string;

export function newId(prefix?: string): Id {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
