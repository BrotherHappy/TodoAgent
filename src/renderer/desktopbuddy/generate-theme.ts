import type { BuddyGeneratedTheme, BuddyImageAnalysis, BuddyMotionClip } from '../../shared/desktopbuddy-contract';
import { generateFramesFromImage, transformImage } from './canvas-transformer';
import { buddyActionDuration, createBuddyActionCurve } from './motion-curves';

/** Offline and permission-free. This does NOT upload the source to an AI. */
export async function generateBuddyTheme(
  image: string,
  analysis: BuddyImageAnalysis,
  actions: string[] = ['pet', 'jump-rope', 'task-carry'],
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<BuddyGeneratedTheme> {
  if (actions.length > 10 || new Set(actions).size !== actions.length) throw new Error('一次最多补充 10 个动作');
  const frames = await generateFramesFromImage(image);
  const animationClips: Record<string, BuddyMotionClip> = {};
  const total = Object.keys(frames).length + actions.length * 33;
  let complete = Object.keys(frames).length;
  onProgress?.(complete, total);
  for (const action of actions) {
    if (!/^[a-z-]{1,40}$/u.test(action)) throw new Error('动作名称无效');
    const curve = createBuddyActionCurve(action);
    const keys: string[] = [];
    for (let i = 0; i < curve.length; i++) {
      signal?.throwIfAborted();
      const key = `${action}_${String(i).padStart(2, '0')}`;
      const pose = curve[i];
      frames[key] = await transformImage(image, {
        width: 256, height: 256, rotation: pose.rotation,
        scaleX: pose.scaleX, scaleY: pose.scaleY, translateX: pose.x * 2.56, translateY: pose.y * 2.56,
      });
      keys.push(key);
      onProgress?.(++complete, total);
      // Yield between frames so Cancel and the live pet keep responding.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    animationClips[action] = { frames: keys, fps: 32_000 / buddyActionDuration(action), loop: false };
  }
  return { frames, analysis, animationClips };
}
