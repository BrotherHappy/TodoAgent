// Adapted from DesktopBuddy (DCDingCong), MIT. See assets/desktopbuddy/licenses/DesktopBuddy-LICENSE.
export interface TransformOptions {
  width: number;
  height: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  translateX?: number;
  translateY?: number;
  brightness?: number;
  saturate?: number;
  contrast?: number;
  hueRotate?: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

export async function transformImage(imageDataUrl: string, options: TransformOptions): Promise<string> {
  const img = await loadImage(imageDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = options.height;
  const ctx = canvas.getContext('2d')!;

  // Contain the entire character with a motion gutter. Upstream center-cropped
  // wide/tall images and clipped ears/feet during transformed poses.
  const fit = Math.min(options.width / img.width, options.height / img.height) * .80;
  const drawWidth = img.width * fit;
  const drawHeight = img.height * fit;

  ctx.save();

  const cx = options.width / 2;
  const cy = options.height / 2;
  ctx.translate(cx, cy);

  if (options.rotation) {
    ctx.rotate((options.rotation * Math.PI) / 180);
  }

  const sx = options.scaleX ?? 1;
  const sy = options.scaleY ?? 1;
  ctx.scale(sx, sy);

  const tx = options.translateX ?? 0;
  const ty = options.translateY ?? 0;

  const filters: string[] = [];
  if (options.brightness !== undefined && options.brightness !== 0) {
    filters.push(`brightness(${1 + options.brightness})`);
  }
  if (options.saturate !== undefined && options.saturate !== 1) {
    filters.push(`saturate(${options.saturate})`);
  }
  if (options.contrast !== undefined && options.contrast !== 1) {
    filters.push(`contrast(${options.contrast})`);
  }
  if (options.hueRotate) {
    filters.push(`hue-rotate(${options.hueRotate}deg)`);
  }
  if (filters.length > 0) {
    ctx.filter = filters.join(' ');
  }

  ctx.drawImage(
    img,
    -drawWidth / 2 + tx, -drawHeight / 2 + ty, drawWidth, drawHeight
  );

  ctx.restore();

  return canvas.toDataURL('image/png');
}

export async function generateFramesFromImage(imageDataUrl: string): Promise<Record<string, string>> {
  const s = 380;
  const base: TransformOptions = { width: s, height: s };

  const frameDefs: Record<string, TransformOptions> = {
    // === 待机：7帧循环（呼吸+摇晃+张望） ===
    idle_0: { ...base },
    idle_1: { ...base, scaleX: 1.012, scaleY: 1.012, translateY: -1.5 },
    idle_2: { ...base, scaleX: 0.992, scaleY: 0.992, translateY: 1 },
    idle_3: { ...base, rotation: -1.5, translateY: -0.5 },
    idle_4: { ...base, rotation: 1.5, translateY: -0.5 },
    idle_5: { ...base, translateX: -3, translateY: -1 },
    idle_6: { ...base, translateX: 3, translateY: -1 },

    // === 注意力 ===
    attention: { ...base, translateY: -4, scaleX: 1.02, scaleY: 1.02, brightness: 0.03 },
    attention_look: { ...base, translateX: 4, translateY: -2, scaleX: 1.01 },

    // === 触摸反馈：3帧组合 ===
    touch_0: { ...base, scaleX: 1.05, scaleY: 1.05, brightness: 0.1 },
    touch_1: { ...base, scaleX: 0.97, scaleY: 1.04, brightness: 0.12, hueRotate: 10 },
    touch_2: { ...base, scaleX: 1.03, scaleY: 0.96, brightness: 0.08 },

    // === 拖拽：3帧 ===
    drag_0: { ...base, rotation: -6, scaleY: 1.03 },
    drag_1: { ...base, rotation: 6, scaleY: 1.03 },
    drag_2: { ...base, scaleY: 1.06, scaleX: 0.94, translateY: 2 },

    // === 释放回弹 ===
    drop: { ...base, scaleX: 1.04, scaleY: 0.95, translateY: 3, brightness: 0.02 },

    // === 犯困：3帧循环 ===
    sleepy_0: { ...base, brightness: -0.18, translateY: 2, scaleX: 0.97, scaleY: 0.97 },
    sleepy_1: { ...base, brightness: -0.22, rotation: 3, translateY: 3, scaleX: 0.96, scaleY: 0.96 },
    sleepy_2: { ...base, brightness: -0.28, rotation: -2, translateY: 4, scaleX: 0.95, scaleY: 0.95 },

    // === 睡觉 ===
    sleep: { ...base, brightness: -0.32, scaleX: 0.94, scaleY: 0.94, translateY: 5 },
    sleep_breathe: { ...base, brightness: -0.3, scaleX: 0.95, scaleY: 0.96, translateY: 4 },

    // === 开心 ===
    happy_0: { ...base, scaleX: 1.04, scaleY: 1.04, brightness: 0.08, translateY: -2 },
    happy_1: { ...base, scaleX: 0.97, scaleY: 1.05, brightness: 0.1, hueRotate: 8 },

    // === 伤心 ===
    sad: { ...base, translateY: 3, saturate: 0.4, brightness: -0.1 },
    sad_look: { ...base, translateY: 2, translateX: -2, saturate: 0.5, brightness: -0.08 },

    // === 思考 ===
    thinking_0: { ...base, translateX: 3, translateY: -2, rotation: -2 },
    thinking_1: { ...base, translateX: -2, translateY: -3, rotation: 2 },

    // === 说话 ===
    speaking_0: { ...base, scaleY: 1.02, translateY: -1, brightness: 0.03 },
    speaking_1: { ...base, scaleX: 1.01, scaleY: 0.99, translateY: 0 },

    // === 早晨醒来 ===
    morning: { ...base, brightness: 0.06, scaleX: 1.02, scaleY: 1.01, translateY: -1, saturate: 1.1 },

    // === 专注陪伴 ===
    focus: { ...base, scaleX: 0.99, scaleY: 0.99, brightness: -0.05, translateX: 1 },

    // === 夜间安静 ===
    night: { ...base, brightness: -0.15, saturate: 0.7, scaleX: 0.98, scaleY: 0.98, hueRotate: -15 },

    // === 确认/等待 ===
    confirm: { ...base, translateY: -2, scaleX: 1.02, scaleY: 1.02, brightness: 0.04 },

    // === 错误 ===
    error: { ...base, rotation: -2, translateY: 2, saturate: 0.6, brightness: -0.08, hueRotate: -10 }
  };

  const result: Record<string, string> = {};
  for (const [key, opts] of Object.entries(frameDefs)) {
    result[key] = await transformImage(imageDataUrl, opts);
  }
  return result;
}
