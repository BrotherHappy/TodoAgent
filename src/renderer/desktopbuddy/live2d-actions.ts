import type { PetAction } from '../pet-behavior';
import { buddyActionDuration, buddyActionLoops, buddyActionProgress } from './motion-curves';

/** Normalized, additive joint cues; never manipulate opacity, parts or outfits. */
export interface BuddyJointPose {
  headX: number; headY: number; headZ: number;
  bodyX: number; bodyY: number; bodyZ: number;
  armL: number; armR: number; earL: number; earR: number;
  mouth: number; smile: number; eyelids: number;
}
export const neutralBuddyJoints: BuddyJointPose = {
  headX: 0, headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0,
  armL: 0, armR: 0, earL: 0, earR: 0, mouth: 0, smile: 0, eyelids: 0,
};
const clamp = (value: number, lo = -1, hi = 1) => {
  const bounded = Math.max(lo, Math.min(hi, value));
  // Keep endpoint poses structurally neutral as well as visually neutral.
  // JavaScript preserves -0, which otherwise makes strict pose comparisons
  // fail when a completed animation lands on a negative sine sample.
  return bounded === 0 ? 0 : bounded;
};
const smooth = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

export function sampleBuddyJoints(action: PetAction, elapsed: number): BuddyJointPose {
  const t = buddyActionProgress(action, elapsed), phase = t * Math.PI * 2;
  const wave = Math.sin(phase), twice = Math.sin(phase * 2);
  const duration = buddyActionDuration(action);
  const envelope = smooth(elapsed / 180) * (buddyActionLoops(action) ? 1 : smooth((duration - elapsed) / Math.min(400, duration * .25)));
  const pose = { ...neutralBuddyJoints };
  switch (action) {
    case 'idle': break;
    case 'wave': pose.armL = .35 + .24 * twice; pose.headZ = .15 * wave; pose.smile = .45; break;
    case 'stretch': pose.armL = pose.armR = .4; pose.headY = .34; pose.bodyY = .24; pose.eyelids = .3; break;
    case 'yawn': pose.headY = .25; pose.mouth = .7 * Math.sin(Math.PI * t); pose.eyelids = .65; break;
    case 'nap': pose.headY = -.22; pose.headZ = -.1; pose.eyelids = .97; pose.bodyY = -.1; break;
    case 'read': case 'focus': pose.headY = -.18; pose.headX = .13 * wave; pose.bodyX = .035 * wave; break;
    case 'play': pose.headZ = .3 * twice; pose.armL = .25 + .18 * wave; pose.armR = .25 - .18 * wave; pose.smile = .6; break;
    case 'drink': pose.headY = -.2 + .12 * wave; pose.armR = .35; pose.mouth = .18 * Math.max(0, twice); break;
    case 'look-left': pose.headX = -.55; pose.bodyX = -.12; break;
    case 'look-right': pose.headX = .55; pose.bodyX = .12; break;
    case 'head-tilt': pose.headZ = -.38; pose.headY = .12; pose.earR = .25; break;
    case 'tail-wag': pose.bodyX = .2 * twice; pose.bodyZ = .15 * twice; pose.smile = .45; pose.earL = .15; break;
    case 'ear-twitch': pose.earL = .65 * Math.max(0, twice); pose.earR = .35 * Math.max(0, -twice); pose.headZ = .06 * twice; break;
    case 'sit': case 'break': case 'focus-paused': pose.headY = -.12; pose.eyelids = .18; pose.bodyY = -.1; break;
    case 'dance': pose.headZ = .24 * twice; pose.bodyZ = -.16 * twice; pose.armL = .3 + .2 * twice; pose.armR = .3 - .2 * twice; pose.smile = .5; break;
    case 'hum': pose.headZ = .16 * wave; pose.eyelids = .3; pose.mouth = .12 * Math.max(0, twice); pose.smile = .4; break;
    case 'inspect': case 'search': pose.headX = .36 * wave; pose.headY = .12 * Math.cos(phase); pose.bodyX = .08 * wave; break;
    case 'tidy': case 'task-plan': pose.headX = .22 * wave; pose.headY = -.12; pose.armL = .2 + .1 * twice; pose.armR = .2 - .1 * twice; break;
    case 'type': case 'work': pose.headY = -.16; pose.armL = .23 + .15 * twice; pose.armR = .23 - .15 * twice; pose.bodyY = .035 * twice; break;
    case 'float': pose.headY = .18; pose.armL = .15; pose.armR = .15; pose.bodyZ = .1 * wave; break;
    case 'peek': pose.headX = -.35; pose.headZ = -.22; pose.bodyX = .16; break;
    case 'pet': pose.headZ = -.3 + .12 * wave; pose.headY = .15; pose.eyelids = .65; pose.smile = .7; pose.earL = .23; pose.earR = .15; break;
    case 'poke': pose.headY = .3; pose.headZ = .25 * wave; pose.mouth = .25; pose.earL = .35; pose.earR = .35; break;
    case 'tickle': pose.headZ = .3 * twice; pose.bodyX = .12 * twice; pose.smile = .7; pose.mouth = .18 + .12 * twice; pose.eyelids = .65; break;
    case 'high-five': pose.armL = .75; pose.headY = .2; pose.smile = .65; pose.earL = .35; break;
    case 'snack': pose.headY = -.17; pose.armL = .28; pose.armR = .28; pose.mouth = .3 * Math.max(0, twice); pose.smile = .35; break;
    case 'jump-rope-ready': pose.armL = .22; pose.armR = .22; pose.headY = -.12; break;
    case 'jump-rope': pose.armL = .3 + .2 * wave; pose.armR = .3 + .2 * wave; pose.earL = -.3 * wave; pose.earR = -.3 * wave; pose.headY = .14 * wave; pose.smile = .45; break;
    case 'drag': pose.armL = .38; pose.armR = .38; pose.earL = -.3; pose.earR = -.3; pose.headZ = .18 * wave; pose.mouth = .2; break;
    case 'celebrate': case 'task-complete': case 'sync-success': pose.armL = .45 + .2 * twice; pose.armR = .45 - .2 * twice; pose.headY = .2; pose.smile = .8; pose.eyelids = .35; break;
    case 'task-carry': pose.armL = .42; pose.armR = .42; pose.headY = -.15; pose.bodyZ = .1 * twice; break;
    case 'task-drop': pose.headY = -.25; pose.armL = .3 - .2 * t; pose.armR = .3 - .2 * t; pose.smile = .4; break;
    case 'task-clear': pose.headY = .23; pose.smile = .65; pose.headZ = .13 * wave; break;
    case 'sync': pose.headX = .18 * wave; pose.armL = .25 + .15 * wave; pose.armR = .25 - .15 * wave; break;
    case 'sync-error': case 'agent-error': pose.headY = -.18; pose.headZ = -.22; pose.smile = -.25; pose.earL = -.35; pose.earR = -.35; break;
    case 'alert': case 'approve': pose.headY = .17; pose.headZ = .16 + .05 * wave; pose.armL = .25; pose.earL = .18; break;
    case 'think': pose.headZ = -.3 + .07 * wave; pose.headY = .14; pose.armR = .25; break;
    case 'juggle': pose.armL = .35 + .22 * twice; pose.armR = .35 - .22 * twice; pose.headX = .2 * twice; pose.headY = .2; break;
    default: { const exhaustive: never = action; return exhaustive; }
  }
  for (const key of Object.keys(pose) as (keyof BuddyJointPose)[]) pose[key] = clamp(pose[key] * envelope) || 0;
  return pose;
}

export interface CubismParameterModel {
  getModel(): { parameters: { ids: ArrayLike<string>; minimumValues: ArrayLike<number>; maximumValues: ArrayLike<number>; defaultValues: ArrayLike<number> } };
  getParameterValueByIndex(index: number): number;
  setParameterValueByIndex(index: number, value: number, weight?: number): void;
}
interface Parameter { index: number; id: string; min: number; max: number; initial: number }
type Channel = Exclude<keyof BuddyJointPose, 'eyelids'> | 'eyeL' | 'eyeR' | 'eyeX' | 'eyeY' | 'breath';
const aliases: Record<Channel, string[]> = {
  headX: ['ParamAngleX'], headY: ['ParamAngleY'], headZ: ['ParamAngleZ'],
  bodyX: ['ParamBodyAngleX'], bodyY: ['ParamBodyAngleY'], bodyZ: ['ParamBodyAngleZ'],
  armL: ['ParamArmL', 'ParamArmLA', 'ParamArmL01', 'ParamHandL'],
  armR: ['ParamArmR', 'ParamArmRA', 'ParamArmR01', 'ParamHandR'],
  earL: ['ParamEarL'], earR: ['ParamEarR'], mouth: ['ParamMouthOpenY'], smile: ['ParamMouthForm'],
  eyeL: ['ParamEyeLOpen'], eyeR: ['ParamEyeROpen'], eyeX: ['ParamEyeBallX'], eyeY: ['ParamEyeBallY'], breath: ['ParamBreath'],
};
const canonicalId = (id: string) => id.replace(/_/gu, '').toLowerCase();

/**
 * Apply before Cubism's model.update, after authored motions/physics. Cubism
 * restores the baseline afterwards, so these cues do not accumulate drift.
 * Wanko's PARAM_ANGLE_X and ParamAngleX must resolve to the SAME real joint;
 * calling Cubism's getParameterIndex for a missing ID silently makes a dummy.
 */
export function createBuddyJointDriver(core: CubismParameterModel, clock: () => number = () => performance.now()) {
  const parameters = core.getModel().parameters;
  const known = new Map(Array.from(parameters.ids, (id, index) => [canonicalId(id), { index, id,
    min: parameters.minimumValues[index], max: parameters.maximumValues[index], initial: parameters.defaultValues[index] }]));
  const bindings = new Map<Channel, Parameter>();
  for (const [channel, names] of Object.entries(aliases) as [Channel, string[]][]) {
    const parameter = names.map(name => known.get(canonicalId(name))).find(Boolean);
    if (parameter && Number.isFinite(parameter.min) && Number.isFinite(parameter.max)) bindings.set(channel, parameter);
  }
  let action: PetAction = 'idle', key = '', started = clock(), previous = started;
  let reducedMotion = false, breathing = true, gaze = { x: 0, y: 0 };
  let smoothedGaze = { x: 0, y: 0 };
  const joints = { ...neutralBuddyJoints };
  const write = (parameter: Parameter, value: number) => {
    if (Number.isFinite(value)) core.setParameterValueByIndex(parameter.index, clamp(value, parameter.min, parameter.max));
  };
  const add = (channel: Channel, normalized: number, legacyOnly = false) => {
    const p = bindings.get(channel);
    if (!p || !normalized || (legacyOnly && !p.id.includes('_'))) return;
    // Some authored joints rest at a range endpoint. A positive cue must
    // still move them when the current motion has brought them to the other
    // end; using only max-default could silently give a zero-length cue.
    const span = Math.max(p.max - p.initial, p.initial - p.min);
    write(p, core.getParameterValueByIndex(p.index) + normalized * span);
  };
  return {
    parameterIds: [...bindings.values()].map(p => p.id),
    setAction(next: PetAction, eventKey = next as string) {
      if (next === action && key === eventKey) return;
      action = next; key = eventKey; started = clock();
    },
    setPreferences(next: { reducedMotion?: boolean; breathing?: boolean }) {
      reducedMotion = next.reducedMotion ?? reducedMotion; breathing = next.breathing ?? breathing;
    },
    focus(x: number, y: number) { gaze = { x: clamp(x), y: clamp(y) }; },
    update() {
      const now = clock(), dt = Math.max(0, Math.min(50, now - previous)); previous = now;
      const blend = 1 - Math.exp(-dt / (action === 'jump-rope' ? 24 : 110));
      const target = reducedMotion ? neutralBuddyJoints : sampleBuddyJoints(action, now - started);
      for (const channel of Object.keys(joints) as (keyof BuddyJointPose)[]) {
        joints[channel] += (target[channel] - joints[channel]) * blend;
        if (channel !== 'eyelids') add(channel, joints[channel]);
      }
      // Slow micro-movements repair the legacy-ID model without doubling the
      // SDK's own gaze/breath on newer models. They never shift the window.
      smoothedGaze.x += (gaze.x - smoothedGaze.x) * blend;
      smoothedGaze.y += (gaze.y - smoothedGaze.y) * blend;
      if (!reducedMotion) {
        add('headX', smoothedGaze.x * .45, true); add('headY', smoothedGaze.y * .3, true);
        add('eyeX', smoothedGaze.x, true); add('eyeY', smoothedGaze.y, true);
        if (breathing) {
          add('headZ', Math.sin(now / 2400) * .035, true);
          add('bodyY', Math.sin(now / 1600) * .055, true);
          add('breath', .32 + Math.sin(now / 1600) * .18, true);
        }
      }
      // Blink even while an Idle motion is active (the SDK otherwise skips
      // its eye-blink helper). Blend lids instead of changing the whole image.
      const blinkPhase = (now % 4700 - 4150) / 190;
      const blink = !reducedMotion && blinkPhase > 0 && blinkPhase < 1 ? Math.sin(blinkPhase * Math.PI) ** 2 : 0;
      const close = Math.max(joints.eyelids, blink);
      for (const channel of ['eyeL', 'eyeR'] as const) {
        const p = bindings.get(channel);
        if (p && close > .001) write(p, p.min + (core.getParameterValueByIndex(p.index) - p.min) * (1 - close));
      }
    },
  };
}
