import { describe, expect, it, vi } from 'vitest';
import { buddyActionFromIntent, buddyIntent } from '../src/renderer/desktopbuddy/behavior';
import { buddyActionDuration, buddyActionProgress } from '../src/renderer/desktopbuddy/motion-curves';
import { createBuddyJointDriver, neutralBuddyJoints, sampleBuddyJoints } from '../src/renderer/desktopbuddy/live2d-actions';
import { petActionDefinitions, type PetAction } from '../src/renderer/pet-behavior';

const actions = Object.keys(petActionDefinitions) as PetAction[];
describe('DesktopBuddy action compatibility', () => {
  it.each(actions)('%s has an explicit intent and bounded continuous joint cues', action => {
    expect(buddyIntent(action).behavior).toBeTruthy();
    const duration = buddyActionDuration(action);
    let movement = 0;
    let previous = sampleBuddyJoints(action, 0);
    for (let time = 16; time < duration; time += 16) {
      const pose = sampleBuddyJoints(action, time);
      for (const key of Object.keys(pose) as (keyof typeof pose)[]) {
        expect(Number.isFinite(pose[key])).toBe(true);
        expect(Math.abs(pose[key])).toBeLessThanOrEqual(1);
        expect(Math.abs(pose[key] - previous[key])).toBeLessThan(.25);
        movement += Math.abs(pose[key]);
      }
      previous = pose;
    }
    if (action !== 'idle') expect(movement).toBeGreaterThan(1);
  });

  it('keeps long running work/search/focus alive and matches the 820ms rope cycle', () => {
    for (const action of ['work', 'think', 'search', 'focus', 'sync'] as const) {
      const duration = buddyActionDuration(action);
      expect(buddyActionProgress(action, duration * 3.25)).toBeCloseTo(.25);
      expect(sampleBuddyJoints(action, duration * 3.25)).not.toEqual(neutralBuddyJoints);
      expect(sampleBuddyJoints(action, duration * 3.25)).not.toEqual(sampleBuddyJoints(action, duration * 3.75));
    }
    expect(buddyActionDuration('jump-rope')).toBe(820);
    expect(sampleBuddyJoints('jump-rope', 821)).toEqual(neutralBuddyJoints);
  });

  it('gives character-specific buttons a body action, not only an Idle/TapBody string', () => {
    expect(buddyActionFromIntent({ behavior: 'touchReaction', variant: 'default' })).toBe('pet');
    expect(buddyActionFromIntent({ behavior: 'optionalCare', variant: 'play' })).toBe('play');
    expect(buddyActionFromIntent({ behavior: 'lifeRoutine', variant: 'rest' })).toBe('sit');
  });
});

function fixture(ids: string[]) {
  const minimumValues = ids.map(id => /open|breath/iu.test(id) ? 0 : -30);
  const maximumValues = ids.map(id => /open|breath/iu.test(id) ? 1 : 30);
  const defaultValues = ids.map(id => /eye.*open/iu.test(id) ? 1 : 0);
  let now = 0;
  const values: number[] = [...defaultValues];
  const core = {
    getModel: () => ({ parameters: { ids, minimumValues, maximumValues, defaultValues } }),
    getParameterValueByIndex: (index: number) => values[index],
    setParameterValueByIndex: vi.fn((index: number, value: number) => { values[index] = value; }),
  };
  const driver = createBuddyJointDriver(core, () => now);
  const step = (time: number) => {
    now = time;
    defaultValues.forEach((value, index) => { values[index] = value; });
    driver.update();
    return [...values];
  };
  return { core, driver, values, step };
}

describe('Live2D real-parameter driver', () => {
  it.each(['PARAM_ANGLE_X', 'ParamAngleX'])('resolves %s without creating invisible dummy parameters', id => {
    const { driver, values, step } = fixture([id, 'PARAM_EYE_L_OPEN', 'PARAM_HAND_L', 'ParamOpacity']);
    expect(driver.parameterIds).toEqual([id, 'PARAM_HAND_L', 'PARAM_EYE_L_OPEN']);
    driver.setPreferences({ breathing: false });
    driver.setAction('look-left', 'look-1');
    for (let i = 0; i <= 700; i += 16) step(i);
    expect(values[0]).toBeLessThan(-10);
    expect(values[3]).toBe(0);
  });

  it('restores real blinking, breathing and gaze on uppercase legacy models', () => {
    const { driver, values, step } = fixture(['PARAM_ANGLE_X', 'PARAM_ANGLE_Y', 'PARAM_BREATH', 'PARAM_EYE_L_OPEN', 'PARAM_EYE_R_OPEN']);
    driver.focus(.8, .5);
    for (let i = 0; i <= 1000; i += 16) step(i);
    expect(values[0]).toBeGreaterThan(8);
    expect(values[1]).toBeGreaterThan(3);
    expect(values[2]).toBeGreaterThan(.2);
    expect(step(4245).slice(3)).toEqual([0, 0]);
    expect(step(4500).slice(3)).toEqual([1, 1]);
  });

  it('restarts repeated gestures by event key, preserving a smooth joint handoff', () => {
    const { driver, step } = fixture(['PARAM_HAND_L', 'PARAM_ANGLE_Z']);
    driver.setPreferences({ breathing: false });
    driver.setAction('high-five', 'one');
    for (let i = 0; i <= 3200; i += 16) step(i);
    expect(step(3201)[0]).toBeCloseTo(0, 1);
    driver.setAction('high-five', 'one');
    expect(step(3400)[0]).toBeCloseTo(0, 1);
    driver.setAction('high-five', 'two');
    for (let i = 3416; i <= 4200; i += 16) step(i);
    expect(step(4201)[0]).toBeGreaterThan(15);
  });

  it('does not touch unknown model parameters or change opacity and respects reduced motion', () => {
    const { core, driver, values, step } = fixture(['PARAM_ANGLE_Z', 'ParamOpacity', 'ParamArmChange', 'ParamHandLightAOn']);
    driver.setAction('dance', 'one');
    driver.setPreferences({ reducedMotion: true });
    for (let i = 0; i < 5000; i += 16) step(i);
    expect(core.setParameterValueByIndex).not.toHaveBeenCalled();
    expect(values).toEqual([0, 0, 0, 0]);
  });
});
