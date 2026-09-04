import { describe, expect, it } from 'vitest';
import { buddyPersonaInstructions, trimBuddyHistory } from '../src/shared/desktopbuddy-contract';
import { createBuddyActionCurve, sampleBuddyCurve, supplementalBuddyActions } from '../src/renderer/desktopbuddy/motion-curves';
import { stepBuddyPhysics, stepBuddySpring } from '../electron/buddy-physics';

describe('DesktopBuddy integration contracts', () => {
  it('keeps complete user/assistant rounds and enforces 4–50 rounds', () => {
    const history = Array.from({ length: 60 }, (_, i) => [{ role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` }]).flat();
    expect(trimBuddyHistory(history, 4)).toHaveLength(8);
    expect(trimBuddyHistory(history, 50)).toHaveLength(100);
    expect(trimBuddyHistory(history, 100)[0].content).toBe('u10');
    expect(trimBuddyHistory([{ role: 'assistant' }, ...history], 4)[0].role).toBe('user');
  });
  it('has four distinct non-coercive persona instructions', () => {
    expect(Object.keys(buddyPersonaInstructions)).toEqual(['gentle', 'witty', 'quiet', 'efficient']);
    expect(new Set(Object.values(buddyPersonaInstructions)).size).toBe(4);
  });
  it.each(supplementalBuddyActions)('%s generates 33 continuous bounded motion keys', action => {
    const curve = createBuddyActionCurve(action);
    expect(curve).toHaveLength(33);
    expect(curve[0]).toEqual(curve[32]);
    for (let i = 1; i < curve.length; i++) {
      expect(Math.abs(curve[i].y - curve[i - 1].y)).toBeLessThan(4);
      expect(Math.abs(curve[i].rotation - curve[i - 1].rotation)).toBeLessThan(3);
    }
    expect(sampleBuddyCurve(curve, .5)).toEqual(curve[16]);
  });
  it('settles a thrown pet at the ground without escaping a multi-monitor work area', () => {
    const area = { x: -1920, y: 24, width: 1920, height: 1056 };
    const size = { width: 148, height: 148 };
    let state = { x: -1900, y: 120, vx: -1400, vy: -800, settled: false };
    for (let i = 0; i < 700; i++) {
      state = { settled: false, ...stepBuddyPhysics(state, area, size, 1 / 60, { gravity: true, inertia: true }) };
      expect(state.x).toBeGreaterThanOrEqual(area.x);
      expect(state.x).toBeLessThanOrEqual(-148);
      expect(state.y).toBeGreaterThanOrEqual(24);
      expect(state.y).toBeLessThanOrEqual(932);
    }
    expect(state.settled).toBe(true);
    expect(state.y).toBe(932);
  });
  it('springs from the actual position and settles without a first-frame teleport', () => {
    let state = { x: 30, y: 200, vx: 0, vy: 0, settled: false };
    const target = { x: 10, y: 200 };
    state = { settled: false, ...stepBuddySpring(state, target, .016) };
    expect(state.x).toBeGreaterThan(28);
    for (let i = 0; i < 120; i++) state = { settled: false, ...stepBuddySpring(state, target, .016) };
    expect(state).toMatchObject({ ...target, settled: true });
  });
});
