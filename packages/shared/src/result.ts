export type Result<T, E = JarvisError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type ErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'PROVIDER_ERROR'
  | 'NOT_CONFIGURED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'LICENSE_REQUIRED'
  | 'UNSUPPORTED_PLATFORM'
  | 'INTERNAL';

export class JarvisError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'JarvisError';
  }
}

export function toJarvisError(e: unknown): JarvisError {
  if (e instanceof JarvisError) return e;
  if (e instanceof Error) {
    if (e.name === 'AbortError') return new JarvisError('CANCELLED', e.message);
    return new JarvisError('INTERNAL', e.message);
  }
  return new JarvisError('INTERNAL', String(e));
}
