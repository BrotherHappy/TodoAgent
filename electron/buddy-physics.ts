// Physics constants and interactions adapted from DesktopBuddy physicsAnimator
// (MIT, DCDingCong). Integrate real elapsed time and begin springs at the
// current location rather than teleporting to their target before animating.
export interface BuddyPhysicsState { x: number; y: number; vx: number; vy: number; settled?: boolean }
export interface BuddyBounds { x: number; y: number; width: number; height: number }
export interface BuddyPhysicsOptions { gravity: boolean; inertia: boolean }
export function stepBuddyPhysics(state: BuddyPhysicsState, area: BuddyBounds, size: { width: number; height: number }, dt: number, options: BuddyPhysicsOptions): BuddyPhysicsState {
  const step = Math.min(.032, Math.max(.001, dt));
  const right = Math.max(area.x, area.x + area.width - size.width);
  const bottom = Math.max(area.y, area.y + area.height - size.height);
  let vx = state.vx * Math.exp(-step * 1.8);
  let vy = state.vy + (options.gravity ? 1800 * step : 0);
  if (!options.gravity) vy *= Math.exp(-step * 2.5);
  let x = state.x + vx * step, y = state.y + vy * step;
  if (x < area.x || x > right) { x = Math.max(area.x, Math.min(right, x)); vx *= -.35; }
  if (y < area.y || y > bottom) { y = Math.max(area.y, Math.min(bottom, y)); vy *= -.35; }
  if (options.gravity && bottom - y < .75 && Math.abs(vy) < 30) { y = bottom; vy = 0; vx *= Math.exp(-step * 10); }
  const settled = options.gravity ? y === bottom && Math.abs(vx) < 2 && vy === 0 : Math.abs(vx) + Math.abs(vy) < 2;
  return { x, y, vx, vy, settled };
}
export function stepBuddySpring(state: BuddyPhysicsState, target: { x: number; y: number }, dt: number): BuddyPhysicsState {
  const step = Math.max(.001, Math.min(.025, dt));
  const vx = state.vx + ((target.x - state.x) * 220 - state.vx * 24) * step;
  const vy = state.vy + ((target.y - state.y) * 220 - state.vy * 24) * step;
  const x = state.x + vx * step, y = state.y + vy * step;
  const settled = Math.abs(x - target.x) + Math.abs(y - target.y) < .5 && Math.abs(vx) + Math.abs(vy) < 3;
  return settled ? { ...target, vx: 0, vy: 0, settled } : { x, y, vx, vy, settled };
}
