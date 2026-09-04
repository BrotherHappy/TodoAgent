import type * as PIXI from 'pixi.js';
import type { Live2DModelLike } from './live2d-renderer';

type PixiModule = typeof PIXI;
export type BuddyRenderHealth = 'ready' | 'recovering' | 'error';
interface Surface {
  canvas: HTMLCanvasElement;
  model: Live2DModelLike;
  width: number;
  height: number;
  size: number;
  fit: (width: number, height: number, size: number) => void;
  onFrame?: () => void;
  onHealth?: (health: BuddyRenderHealth, message: string) => void;
}
interface RegisteredSurface extends Surface {
  context: CanvasRenderingContext2D;
  staging: HTMLCanvasElement;
  stagingContext: CanvasRenderingContext2D;
  lastFrame: number;
  lastProbe: number;
  frames: number;
  fps: number;
  dirty: boolean;
  health?: BuddyRenderHealth;
}

let sharedEngine: SharedLive2DEngine | undefined;
let engineSequence = 0;

/**
 * Cubism 4 keeps its shader cache in a module singleton. Independent WebGL
 * renderers in the SAME window overwrite each other's shader/context state.
 * Render every model through one GPU context, then commit complete frames to
 * persistent 2D canvases. Home/Focus/previews may coexist without blanking the
 * desktop character, and a lost GPU context cannot erase the last good frame.
 */
class SharedLive2DEngine {
  private renderer?: PIXI.Renderer;
  private gpuCanvas?: HTMLCanvasElement;
  private readonly surfaces = new Set<RegisteredSurface>();
  private readonly probe = document.createElement('canvas');
  private readonly probeContext: CanvasRenderingContext2D;
  private frame = 0;
  private recoveryTimer = 0;
  private recoveryAttempts = 0;
  private healthySince = 0;
  private contextLost = false;
  private destroyed = false;
  private width = 384;
  private height = 384;
  private readonly resolution = Math.min(2, window.devicePixelRatio || 1);
  private readonly id = ++engineSequence;

  constructor(private readonly pixi: PixiModule) {
    this.probe.width = this.probe.height = 32;
    const context = this.probe.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法创建宠物绘图缓冲');
    this.probeContext = context;
    this.createRenderer();
  }

  private createRenderer() {
    const canvas = document.createElement('canvas');
    canvas.hidden = true;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.buddyEngine = String(this.id);
    const renderer = new this.pixi.Renderer({ view: canvas, backgroundAlpha: 0, antialias: true,
      resolution: this.resolution, width: this.width, height: this.height });
    // The canvas is an internal, non-interactive paint buffer. Pixi's
    // AccessibilityManager creates a transparent absolute overlay after the
    // first Tab key, and that overlay can sit above unrelated settings
    // controls because this renderer is attached to document.body. The
    // surrounding BuddyCharacter already exposes the visible avatar as an
    // accessible image, so the internal buffer must not own a second hit
    // target layer.
    this.rendererAccessibilityCleanup(renderer);
    this.gpuCanvas = canvas;
    this.renderer = renderer;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    document.body.appendChild(canvas);
    this.contextLost = false;
  }

  private rendererAccessibilityCleanup(renderer: PIXI.Renderer) {
    renderer.plugins.accessibility?.destroy();
  }

  private disposeRenderer() {
    const renderer = this.renderer;
    this.renderer = undefined;
    this.gpuCanvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.gpuCanvas?.remove();
    this.gpuCanvas = undefined;
    renderer?.destroy(false);
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.scheduleRecovery('图形连接暂时中断，正在恢复动作');
  };

  private setHealth(surface: RegisteredSurface, health: BuddyRenderHealth, message = '') {
    if (surface.health === health) return;
    surface.health = health;
    surface.canvas.dataset.buddyStatus = health;
    surface.onHealth?.(health, message);
  }

  private scheduleRecovery(message: string) {
    if (this.destroyed || this.recoveryTimer) return;
    this.contextLost = true;
    this.healthySince = 0;
    const terminal = this.recoveryAttempts >= 3;
    for (const surface of this.surfaces) this.setHealth(surface, terminal ? 'error' : 'recovering', message);
    if (terminal) return;
    const delay = [250, 1_000, 3_000][this.recoveryAttempts++];
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = 0;
      if (this.destroyed || !this.surfaces.size) return;
      try {
        this.disposeRenderer();
        this.createRenderer();
        for (const surface of this.surfaces) { surface.dirty = true; surface.lastProbe = 0; }
      } catch {
        this.scheduleRecovery('图形连接暂不可用，保留宠物画面；可以重试');
      }
    }, delay);
  }

  register(options: Surface) {
    const context = options.canvas.getContext('2d');
    const staging = document.createElement('canvas');
    const stagingContext = staging.getContext('2d');
    if (!context || !stagingContext) throw new Error('无法创建宠物画布');
    const surface: RegisteredSurface = { ...options,
      width: Math.max(16, Math.min(768, options.width)), height: Math.max(16, Math.min(768, options.height)),
      context, staging, stagingContext,
      lastFrame: 0, lastProbe: 0, frames: 0, fps: 60, dirty: true };
    options.canvas.dataset.buddyRenderPath = 'shared-webgl-buffered';
    options.canvas.dataset.buddyEngineId = String(this.id);
    this.surfaces.add(surface);
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
    return {
      resize: (width: number, height: number, size: number) => {
        surface.width = Math.max(16, Math.min(768, width));
        surface.height = Math.max(16, Math.min(768, height));
        surface.size = size;
        surface.dirty = true;
      },
      setReducedMotion: (enabled: boolean) => { surface.fps = enabled ? 20 : 60; },
      retry: () => { this.recoveryAttempts = 0; this.scheduleRecovery('正在恢复宠物动作'); },
      dispose: () => {
        if (!this.surfaces.delete(surface)) return;
        surface.model.destroy({ children: true, texture: false, baseTexture: false });
        if (!this.surfaces.size) {
          this.destroyed = true;
          cancelAnimationFrame(this.frame); this.frame = 0;
          clearTimeout(this.recoveryTimer);
          this.disposeRenderer();
          if (sharedEngine === this) sharedEngine = undefined;
        }
      },
    };
  }

  private tick = (now: number) => {
    this.frame = 0;
    if (this.destroyed) return;
    if (!this.contextLost && this.renderer && this.gpuCanvas) {
      if (!this.healthySince) this.healthySince = now;
      if (now - this.healthySince > 5_000) this.recoveryAttempts = 0;
      for (const surface of this.surfaces) {
        if (now - surface.lastFrame < 1_000 / surface.fps - .5) continue;
        const dt = Math.min(50, surface.lastFrame ? now - surface.lastFrame : 16);
        surface.lastFrame = now;
        try {
          if (surface.dirty) {
            const width = Math.ceil(surface.width), height = Math.ceil(surface.height);
            if (width > this.width || height > this.height) {
              this.width = Math.max(this.width, width); this.height = Math.max(this.height, height);
              this.renderer.resize(this.width, this.height);
            }
            surface.staging.width = Math.round(width * this.resolution);
            surface.staging.height = Math.round(height * this.resolution);
            surface.fit(width, height, surface.size);
            surface.dirty = false;
          }
          surface.model.update?.(dt);
          this.renderer.render(surface.model as unknown as PIXI.DisplayObject, { clear: true });
          if (this.renderer.gl.isContextLost()) { this.scheduleRecovery('正在恢复宠物绘图连接'); break; }
          const { staging, stagingContext, canvas, context } = surface;
          stagingContext.globalCompositeOperation = 'copy';
          stagingContext.drawImage(this.gpuCanvas, 0, 0, staging.width, staging.height, 0, 0, staging.width, staging.height);
          // Probe real alpha, not a ticking RAF counter. Never replace an
          // already painted pet with an empty GPU frame.
          {
            this.probeContext.globalCompositeOperation = 'copy';
            this.probeContext.drawImage(staging, 0, 0, 32, 32);
            const pixels = this.probeContext.getImageData(0, 0, 32, 32).data;
            let painted = 0;
            for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 16) painted++;
            if (painted < 4) { this.scheduleRecovery('宠物画面尚未就绪，正在重新绘制'); break; }
            surface.lastProbe = now;
          }
          // Resize and draw in one synchronous commit; resizing alone clears
          // the visible canvas and used to expose transparent frames.
          if (canvas.width !== staging.width || canvas.height !== staging.height) {
            canvas.width = staging.width; canvas.height = staging.height;
          }
          context.globalCompositeOperation = 'copy';
          context.drawImage(staging, 0, 0);
          canvas.dataset.buddyFrame = String(++surface.frames);
          this.setHealth(surface, 'ready');
          surface.onFrame?.();
        } catch {
          this.scheduleRecovery('宠物绘图暂时异常，保留上一次完整画面');
          break;
        }
      }
    }
    if (this.surfaces.size) this.frame = requestAnimationFrame(this.tick);
  };
}

export function registerSharedLive2DSurface(pixi: PixiModule, surface: Surface) {
  sharedEngine ??= new SharedLive2DEngine(pixi);
  return sharedEngine.register(surface);
}
