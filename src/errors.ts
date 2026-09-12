export type ErrorCode = 'DISPOSED' | 'INVALID_VALUE' | 'CROSS_ENGINE' | 'INVALID_CONNECTION' | 'NOT_RUNNING' | 'ACTIVATION_FAILED' | 'HOST_FAILURE' | 'UNSUPPORTED';
export class TuneError extends Error {
  override readonly name = 'TuneError';
  constructor(readonly code: ErrorCode, message: string, readonly recovery: string, options?: ErrorOptions) {
    super(message, options);
  }
}
export function finite(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TuneError('INVALID_VALUE', `${name} must be finite and in [${min}, ${max}]; received ${value}.`, `Choose a valid ${name}.`);
  }
  return value;
}
