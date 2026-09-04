// Adapted from DesktopBuddy (DCDingCong), MIT. See assets/desktopbuddy/licenses/DesktopBuddy-LICENSE.
import type { PetThemeRuntimeAssets } from '../../shared/desktopbuddy';
import { registerSharedLive2DSurface, type BuddyRenderHealth } from './shared-live2d-engine';
import { createBuddyJointDriver, type CubismParameterModel } from './live2d-actions';
import type { PetAction } from '../pet-behavior';

export type Live2DRendererStatus = 'missing-assets' | 'loading' | 'ready' | 'error';

export interface Live2DModelLike {
  width: number;
  height: number;
  x: number;
  y: number;
  scale: { set: (x: number, y?: number) => void };
  anchor?: { set: (x: number, y?: number) => void };
  internalModel?: {
    width?: number;
    height?: number;
    originalWidth?: number;
    originalHeight?: number;
    getDrawableIDs?: () => unknown[];
    getDrawableVertices?: (index: number) => ArrayLike<number>;
    coreModel?: Partial<CubismParameterModel> & { getDrawableOpacity?: (index: number) => number };
    on?: (event: string, listener: () => void) => unknown;
    off?: (event: string, listener: () => void) => unknown;
    localTransform?: { a: number; b: number; c: number; d: number; tx: number; ty: number };
    focusController?: { focus(x: number, y: number): void };
    motionManager?: { definitions?: Record<string, unknown[]> };
  };
  motion?: (group: string, index?: number, priority?: number) => Promise<boolean>;
  expression?: (id: string) => unknown;
  focus?: (x: number, y: number) => void;
  update?: (deltaMs: number) => void;
  destroy: (options?: unknown) => void;
}

export interface Live2DRendererController {
  playMotion: (group: string, priority?: 'normal' | 'interrupt') => boolean;
  playExpression: (id: string, durationMs?: number) => boolean;
  resize: (width: number, height: number, size: number) => void;
  focus: (x: number, y: number) => void;
  setReducedMotion?: (enabled: boolean) => void;
  setBreathing?: (enabled: boolean) => void;
  setAction?: (action: PetAction, eventKey: string) => void;
  retry?: () => void;
  dispose: () => void;
}

export interface Live2DRendererResult {
  controller?: Live2DRendererController;
  status: Live2DRendererStatus;
  message: string;
}

const FALLBACK_VIEWPORT = { width: 230, height: 292 };
const MIN_VIEWPORT_SIZE = 16;

function normalizeViewportSize(width: number, height: number, fallback = FALLBACK_VIEWPORT) {
  const nextWidth = Number.isFinite(width) && width >= MIN_VIEWPORT_SIZE ? Math.round(width) : fallback.width;
  const nextHeight = Number.isFinite(height) && height >= MIN_VIEWPORT_SIZE ? Math.round(height) : fallback.height;
  return {
    width: Math.max(MIN_VIEWPORT_SIZE, nextWidth),
    height: Math.max(MIN_VIEWPORT_SIZE, nextHeight)
  };
}

function getCanvasViewportSize(canvas: HTMLCanvasElement, fallback = FALLBACK_VIEWPORT) {
  const parentRect = canvas.parentElement?.getBoundingClientRect();
  return normalizeViewportSize(
    parentRect?.width ?? canvas.clientWidth,
    parentRect?.height ?? canvas.clientHeight,
    fallback
  );
}

const loadedScripts = new Set<string>();
const loadingScripts = new Map<string, Promise<void>>();

async function assertScriptReachable(src: string) {
  const response = await fetch(src, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`无法读取 live2dcubismcore.min.js: HTTP ${response.status}`);
  }
}

async function loadScriptOnce(src: string) {
  if (loadedScripts.has(src)) {
    return;
  }

  const pending = loadingScripts.get(src);
  if (pending) {
    await pending;
    return;
  }

  if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
    loadedScripts.add(src);
    return;
  }

  document.querySelector<HTMLScriptElement>(`script[data-live2d-core="${src}"]`)?.remove();
  // Memoize before the first await; simultaneous Home/Focus/preview mounts
  // must never execute Cubism Core twice and replace its WASM heap.
  const promise = (async () => {
    await assertScriptReachable(src);
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.live2dCore = src;
      script.onload = () => { resolve(); };
      script.onerror = () => {
        script.remove();
        reject(new Error(`无法加载 live2dcubismcore.min.js: ${src}`));
      };
      document.head.appendChild(script);
    });
    if (!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
      throw new Error('live2dcubismcore.min.js 已加载，但没有注册 Live2DCubismCore。');
    }
    loadedScripts.add(src);
  })().finally(() => loadingScripts.delete(src));

  loadingScripts.set(src, promise);
  await promise;
}

function getModelBaseSize(model: Live2DModelLike): { width: number; height: number } {
  const candidates = [
    { width: model.internalModel?.width, height: model.internalModel?.height },
    { width: model.internalModel?.originalWidth, height: model.internalModel?.originalHeight },
    { width: model.width, height: model.height }
  ];

  return (
    candidates.find(
      (candidate): candidate is { width: number; height: number } =>
        typeof candidate.width === 'number' &&
        typeof candidate.height === 'number' &&
        candidate.width > 0 &&
        candidate.height > 0 &&
        Number.isFinite(candidate.width) &&
        Number.isFinite(candidate.height)
    ) ?? { width: 2, height: 2 }
  );
}

const visualBoundsCache = new WeakMap<Live2DModelLike, { x: number; y: number; width: number; height: number }>();
function getModelVisualBounds(model: Live2DModelLike) {
  const cached = visualBoundsCache.get(model);
  if (cached) return cached;
  const internal = model.internalModel;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  // Sample models include large empty document margins. Fit authored meshes,
  // not that empty canvas, once at load; never auto-zoom with each expression.
  const ids = internal?.getDrawableIDs?.() ?? [];
  for (let index = 0; index < ids.length; index++) {
    if (/hitarea/iu.test(String(ids[index])) || (internal?.coreModel?.getDrawableOpacity?.(index) ?? 1) < .02) continue;
    const vertices = internal?.getDrawableVertices?.(index);
    if (!vertices) continue;
    const transform = internal?.localTransform ?? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    for (let i = 0; i + 1 < vertices.length; i += 2) {
      const x = vertices[i] * transform.a + vertices[i + 1] * transform.c + transform.tx;
      const y = vertices[i] * transform.b + vertices[i + 1] * transform.d + transform.ty;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const bounds = right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : { x: 0, y: 0, ...getModelBaseSize(model) };
  visualBoundsCache.set(model, bounds);
  return bounds;
}

function fitModel(model: Live2DModelLike, assets: PetThemeRuntimeAssets, width: number, height: number, size: number) {
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  const modelSize = getModelVisualBounds(model);
  const layout = assets.layout;
  const padding = Math.max(0, Math.min(0.3, layout?.fitPadding ?? 0.12));
  const smallSizeGuard = size < 45 ? 0.78 : 1;
  const baseScale =
    Math.min((safeWidth * (1 - padding * 2)) / modelSize.width, (safeHeight * (0.94 - padding)) / modelSize.height) *
    smallSizeGuard;
  const scale = baseScale * (size / 100);

  try {
    model.scale.set(scale);
    model.x = safeWidth / 2 - (modelSize.x + modelSize.width / 2) * scale + (layout?.offsetX ?? 0);
    model.y = safeHeight * 0.94 - (modelSize.y + modelSize.height) * scale + (layout?.offsetY ?? 0);
  } catch {
    // Late resize callbacks can fire after Pixi has already destroyed transforms.
  }
}

function createMotionQueue(model: Live2DModelLike, isDisposed: () => boolean) {
  // Cubism owns blending and idle scheduling. The upstream 900ms queue
  // could replay a stale touch after the user had already begun dragging.
  return (group: string, priority: 'normal' | 'interrupt' = 'normal') => {
    if (isDisposed() || !model.internalModel?.motionManager?.definitions?.[group]?.length) return false;
    void model.motion?.(group, undefined, priority === 'interrupt' ? 3 : group === 'Idle' ? 1 : 2).catch(() => undefined);
    return true;
  };
}

function createExpressionPlayer(model: Live2DModelLike, isDisposed: () => boolean) {
  let timer = 0;
  return (id: string, durationMs = 1800) => {
    if (isDisposed()) return false;
    if (timer) {
      window.clearTimeout(timer);
    }
    try {
      model.expression?.(id);
      timer = window.setTimeout(() => {
        if (isDisposed()) return;
        try {
          model.expression?.('');
        } catch {
          // Some Cubism models do not support clearing expressions with an empty id.
        }
      }, durationMs);
      return true;
    } catch {
      return false;
    }
  };
}

export async function createLive2DRenderer(
  canvas: HTMLCanvasElement,
  assets: PetThemeRuntimeAssets,
  size: number,
  events: { onFrame?: () => void; onHealth?: (health: BuddyRenderHealth, message: string) => void } = {},
): Promise<Live2DRendererResult> {
  if (!assets.coreUrl || !assets.modelUrl || !assets.coreExists || !assets.modelExists) {
    return {
      status: 'missing-assets',
      message: '缺少 Cubism Core 或 Live2D 模型资源。'
    };
  }

  try {
    const modelUrl = assets.modelUrl;
    await loadScriptOnce(assets.coreUrl);
    const PIXI = await import('pixi.js');
    // Official CSP adapter; do not enable JavaScript unsafe-eval globally.
    const { install } = await import('@pixi/unsafe-eval');
    install(PIXI);
    (window as unknown as { PIXI: unknown }).PIXI = PIXI;
    const { Live2DModel, MotionPreloadStrategy } = await import('pixi-live2d-display/cubism4');
    Live2DModel.registerTicker(PIXI.Ticker);

    const initialSize = getCanvasViewportSize(canvas);
    let viewportSize = initialSize;
    // Share the WebGL renderer/immutable texture cache, NOT a mutable Cubism
    // model. Each preview has its own size, gaze, motion and joint state.
    // Sharing one model doubles joint drivers and lets a large preview move
    // or resize the desktop avatar; it also complicates correct disposal.
    const model = (await Live2DModel.from(modelUrl, {
      autoInteract: false, autoUpdate: false, motionPreload: MotionPreloadStrategy.ALL,
    })) as unknown as Live2DModelLike;
    let disposed = false;

    model.anchor?.set(0, 0);
    const core = model.internalModel?.coreModel;
    const joints = core?.getModel && core.getParameterValueByIndex && core.setParameterValueByIndex
      ? createBuddyJointDriver(core as CubismParameterModel) : undefined;
    if (joints) {
      model.internalModel?.on?.('beforeModelUpdate', joints.update);
      canvas.dataset.buddyJointCount = String(joints.parameterIds.length);
    }
    let surface: ReturnType<typeof registerSharedLive2DSurface>;
    try {
      surface = registerSharedLive2DSurface(PIXI, {
        canvas,
        model,
        ...initialSize,
        size,
        fit: (width, height, nextSize) => fitModel(model, assets, width, height, nextSize),
        onFrame: events.onFrame,
        onHealth: events.onHealth,
      });
    } catch (error) {
      if (joints) model.internalModel?.off?.('beforeModelUpdate', joints.update);
      model.destroy({ children: true, texture: false, baseTexture: false });
      throw error;
    }

    return {
      status: 'ready',
      message: 'Live2D 模型已加载。',
      controller: {
        playMotion: createMotionQueue(model, () => disposed),
        playExpression: createExpressionPlayer(model, () => disposed),
        resize: (width: number, height: number, nextSize: number) => {
          if (disposed) {
            return;
          }
          viewportSize = normalizeViewportSize(width, height, viewportSize);
          surface.resize(viewportSize.width, viewportSize.height, nextSize);
        },
        focus: (x: number, y: number) => {
          if (disposed) return;
          model.internalModel?.focusController?.focus(x, y);
          joints?.focus(x, y);
        },
        setAction: (action, eventKey) => {
          if (disposed) return;
          joints?.setAction(action, eventKey);
          canvas.dataset.buddyAction = action;
          canvas.dataset.buddyActionKey = eventKey;
        },
        setReducedMotion: enabled => { surface.setReducedMotion(enabled); joints?.setPreferences({ reducedMotion: enabled }); },
        setBreathing: enabled => joints?.setPreferences({ breathing: enabled }),
        retry: () => surface.retry(),
        dispose: () => {
          if (disposed) return;
          disposed = true;
          if (joints) model.internalModel?.off?.('beforeModelUpdate', joints.update);
          surface.dispose();
        }
      }
    };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Live2D 渲染器加载失败。'
    };
  }
}
