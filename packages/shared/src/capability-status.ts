/**
 * Every user-visible capability reports an honest status. The UI must only
 * render a capability as "active" when its status is 'active'.
 */
export type CapabilityState =
  'active' | 'degraded' | 'not_configured' | 'disabled' | 'planned' | 'unsupported';

export interface CapabilityStatus {
  id: string;
  label: string;
  state: CapabilityState;
  reason?: string;
  /** What the user/operator must configure to activate it. */
  requirement?: string;
}
