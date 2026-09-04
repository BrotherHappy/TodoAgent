// Theme manifest and image workflow adapted from DesktopBuddy, MIT (DCDingCong).
// Unlike upstream, imported Core scripts never run, paths are confined before
// extraction, and replacing/deleting a theme never destroys an existing folder.
import fs from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open as openZip, type Entry } from 'yauzl';
import { nativeImage } from 'electron';
import { z } from 'zod';
import {
  defaultBuddyPreferences,
  type BuddyAssets, type BuddyGeneratedTheme, type BuddyInteraction,
  type BuddyPreferences, type BuddySnapshot, type BuddyTheme,
  type BuddyThemeManifest,
} from '../../src/shared/desktopbuddy-contract';

const themeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const preferencePatch = z.object({
  themeId: themeIdSchema.optional(),
  gravity: z.boolean().optional(), inertia: z.boolean().optional(),
  edgeSnap: z.boolean().optional(), breathing: z.boolean().optional(),
  cursorFollow: z.boolean().optional(), reducedMotion: z.boolean().optional(),
  persona: z.enum(['gentle', 'witty', 'quiet', 'efficient']).optional(),
  memoryRounds: z.number().int().min(4).max(50).optional(),
}).strict();
const allowedExtensions = new Set(['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md']);
const MAX_THEME_BYTES = 96 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

/** Stream into a fresh, private staging directory; never follow zip symlinks. */
function extractBuddyZip(file: string, root: string, validate: (entry: Entry) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    openZip(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('主题包无法打开')); return; }
      let failed = false;
      const fail = (reason: unknown) => { if (!failed) { failed = true; zip.close(); reject(reason); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!failed) resolve(); });
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          validate(entry);
          const target = safeBuddyPath(root, entry.fileName.replace(/\/$/u, ''));
          if (entry.fileName.endsWith('/')) { await fs.mkdir(target, { recursive: true }); zip.readEntry(); return; }
          await fs.mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<import('node:stream').Readable>((yes, no) => zip.openReadStream(entry, (err, input) => err || !input ? no(err ?? new Error('无法读取主题文件')) : yes(input)));
          let received = 0;
          await pipeline(stream, new Transform({ transform(chunk: Buffer, _encoding, done) {
            received += chunk.length;
            done(received > entry.uncompressedSize || received > MAX_FILE_BYTES ? new Error('主题文件解压大小超限') : null, chunk);
          } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          if (!failed) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

export function safeBuddyPath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.posix.isAbsolute(relative)) {
    throw new Error('主题包含不安全的资源路径');
  }
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('主题资源不能越出自己的文件夹');
  const target = path.resolve(root, normalized);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('主题资源路径无效');
  return target;
}

function parseManifest(value: unknown): BuddyThemeManifest {
  const manifest = z.object({
    schemaVersion: z.literal(1), id: themeIdSchema,
    displayName: z.string().min(1).max(120), version: z.string().max(40),
    type: z.enum(['human', 'animal', 'plant', 'objectSpirit', 'abstract']),
    renderer: z.enum(['live2d', 'staticImage']),
    layout: z.object({ defaultSize: z.number(), minSize: z.number(), maxSize: z.number() }).passthrough(),
    model: z.object({
      core: z.string().optional(), model3: z.string().optional(), preview: z.string().optional(),
      defaultImage: z.string().optional(), staticImages: z.record(z.string(), z.string()).optional(),
    }).passthrough(),
    colors: z.object({ swatches: z.tuple([z.string(), z.string(), z.string()]), cssClass: z.string() }),
    capabilities: z.record(z.string(), z.unknown()), motions: z.record(z.string(), z.unknown()),
    interactions: z.array(z.object({
      id: themeIdSchema, label: z.string().min(1).max(50), behavior: z.string().min(1).max(100),
      cooldownMs: z.number().min(0).max(3_600_000).optional(),
    })).max(40),
    fallback: z.record(z.string(), z.unknown()),
    animationClips: z.record(z.string(), z.object({
      frames: z.array(z.string()).min(2).max(200), fps: z.number().min(1).max(120), loop: z.boolean(),
    })).optional(),
  }).passthrough().parse(value);
  return manifest as unknown as BuddyThemeManifest;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
}
async function atomicJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}

export class DesktopBuddyService {
  readonly builtinRoot: string;
  readonly userRoot: string;
  readonly #settingsPath: string;
  #preferences = { ...defaultBuddyPreferences };
  #themes: BuddyTheme[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #cooldowns = new Map<string, number>();

  constructor(readonly options: {
    appPath: string; userDataPath: string;
    onChange?: (state: BuddySnapshot) => void;
    onInteraction?: (event: BuddyInteraction) => void;
  }) {
    this.builtinRoot = path.join(options.appPath, 'assets', 'desktopbuddy');
    this.userRoot = path.join(options.userDataPath, 'pet', 'buddy-themes');
    this.#settingsPath = path.join(options.userDataPath, 'pet', 'desktopbuddy.json');
  }

  async load(): Promise<void> {
    await fs.mkdir(this.userRoot, { recursive: true });
    try { this.#preferences = { ...defaultBuddyPreferences, ...preferencePatch.parse(readJson(this.#settingsPath)) }; } catch { /* older or missing settings */ }
    this.#reload();
  }
  preferences(): BuddyPreferences { return { ...this.#preferences }; }
  snapshot(): BuddySnapshot { return structuredClone({ preferences: this.#preferences, themes: this.#themes }); }
  #changed(): BuddySnapshot { const snapshot = this.snapshot(); this.options.onChange?.(snapshot); return snapshot; }
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }
  async setPreferences(patch: unknown): Promise<BuddySnapshot> {
    const parsed = preferencePatch.parse(patch);
    return this.#serialize(async () => {
      if (parsed.themeId && !this.#themes.some(t => t.manifest.id === parsed.themeId && t.enabled && t.ready)) {
        throw new Error('这个角色尚未就绪，请检查资源或先启用它');
      }
      const next = { ...this.#preferences, ...parsed };
      await atomicJson(this.#settingsPath, next);
      this.#preferences = next;
      return this.#changed();
    });
  }
  #theme(id: string): BuddyTheme {
    themeIdSchema.parse(id);
    const theme = this.#themes.find(t => t.manifest.id === id);
    if (!theme) throw new Error('没有找到这个角色');
    return theme;
  }
  #resource(theme: BuddyTheme, resource: string): string {
    return theme.origin === 'builtin'
      ? safeBuddyPath(this.builtinRoot, resource.replace(/^assets\//u, ''))
      : safeBuddyPath(path.join(this.userRoot, theme.manifest.id), resource);
  }
  #url(theme: BuddyTheme, resource: string): string {
    const relative = theme.origin === 'builtin' ? resource.replace(/^assets\//u, '') : `${theme.manifest.id}/${resource}`;
    return `pet-asset://${theme.origin}/${relative.split('/').map(encodeURIComponent).join('/')}`;
  }
  assets(id: string): BuddyAssets {
    const theme = this.#theme(id);
    const { manifest } = theme;
    const model = manifest.model;
    return {
      themeId: id, renderer: manifest.renderer, assetDir: '', manifest: structuredClone(manifest), layout: manifest.layout,
      // Only this bundled, reviewed Core is executable, regardless of imported metadata.
      coreUrl: 'pet-asset://builtin/live2d-presets/wanko/live2dcubismcore.min.js',
      coreExists: existsSync(path.join(this.builtinRoot, 'live2d-presets/wanko/live2dcubismcore.min.js')),
      modelUrl: model?.model3 ? this.#url(theme, model.model3) : undefined,
      modelExists: !!model?.model3 && existsSync(this.#resource(theme, model.model3)),
      staticImageUrl: model?.defaultImage ? this.#url(theme, model.defaultImage) : undefined,
      staticImages: model?.staticImages ? Object.fromEntries(Object.entries(model.staticImages).map(([key, file]) => [key, this.#url(theme, file)])) : undefined,
    };
  }
  /** Used by the custom protocol, not exposed to renderer IPC. */
  async resolveAsset(url: string): Promise<string> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'pet-asset:' || !['builtin', 'user'].includes(parsed.hostname)) throw new Error('资源地址无效');
    const relative = decodeURIComponent(parsed.pathname.slice(1));
    const root = parsed.hostname === 'builtin' ? this.builtinRoot : this.userRoot;
    const target = safeBuddyPath(root, relative);
    const extension = path.extname(target).toLowerCase();
    if (extension === '.js') {
      if (parsed.hostname !== 'builtin' || relative !== 'live2d-presets/wanko/live2dcubismcore.min.js') throw new Error('禁止加载主题脚本');
    } else if (!['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new Error('不支持的资源类型');
    const realRoot = await fs.realpath(root);
    const realTarget = await fs.realpath(target);
    if (!realTarget.startsWith(realRoot + path.sep)) throw new Error('资源不能越出主题目录');
    return realTarget;
  }
  #validateResources(theme: BuddyTheme): void {
    const model = theme.manifest.model;
    const files = theme.manifest.renderer === 'live2d' ? [model?.model3] : [model?.defaultImage, ...Object.values(model?.staticImages ?? {})];
    if (files.length === 0 || !files[0]) throw new Error('未配置角色资源');
    for (const file of files) {
      if (!file || !existsSync(this.#resource(theme, file))) throw new Error('角色资源文件缺失');
    }
    if (model?.model3) {
      const modelPath = this.#resource(theme, model.model3);
      const data = readJson(modelPath) as { FileReferences?: unknown };
      const checkRefs = (value: unknown): void => {
        if (typeof value === 'string') {
          // Strings in FileReferences include names, motion groups, and file paths.
          if (value.includes('/') || /\.(moc3|json|png|jpe?g|webp|wav|mp3)$/iu.test(value)) {
            const full = safeBuddyPath(path.dirname(modelPath), value);
            if (!existsSync(full)) throw new Error('模型引用的纹理或动作缺失');
          }
          if (/^[a-z][a-z0-9+.-]*:/iu.test(value) || value.includes('\\')) throw new Error('禁止远程或绝对资源引用');
        } else if (Array.isArray(value)) value.forEach(checkRefs);
        else if (value && typeof value === 'object') Object.values(value).forEach(checkRefs);
      };
      checkRefs(data.FileReferences);
    }
    for (const clip of Object.values(theme.manifest.animationClips ?? {})) {
      if (clip.frames.some(frame => !model?.staticImages?.[frame])) throw new Error('动画帧缺失');
    }
  }
  #reload(): void {
    this.#themes = [];
    for (const origin of ['builtin', 'user'] as const) {
      const root = origin === 'builtin' ? path.join(this.builtinRoot, 'pets/builtin') : this.userRoot;
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          const manifest = parseManifest(readJson(path.join(root, entry.name, 'theme.json')));
          if (origin === 'user' && manifest.id !== entry.name) continue;
          if (this.#themes.some(t => t.manifest.id === manifest.id)) continue;
          let enabled = true;
          try { enabled = (readJson(path.join(root, entry.name, '.desktopbuddy-theme.json')) as { enabled?: boolean }).enabled !== false; } catch { /* defaults */ }
          const theme: BuddyTheme = { manifest, origin, enabled, ready: true };
          try { this.#validateResources(theme); } catch (e) { theme.ready = false; theme.issue = e instanceof Error ? e.message : '资源无效'; }
          this.#themes.push(theme);
        } catch { /* Invalid manifests are never selectable or executable. */ }
      }
    }
    const order = ['wanko-live2d', 'hiyori-live2d', 'rice-live2d', 'mark-live2d', 'haru-live2d'];
    this.#themes.sort((a, b) => (order.indexOf(a.manifest.id) < 0 ? 99 : order.indexOf(a.manifest.id)) - (order.indexOf(b.manifest.id) < 0 ? 99 : order.indexOf(b.manifest.id)));
    if (!this.#themes.some(t => t.manifest.id === this.#preferences.themeId && t.ready && t.enabled)) {
      this.#preferences.themeId = this.#themes.find(t => t.ready && t.enabled)?.manifest.id ?? defaultBuddyPreferences.themeId;
    }
  }
  async importZip(zipPath: string): Promise<BuddySnapshot> {
    return this.#serialize(async () => {
      if ((await fs.stat(zipPath)).size > MAX_THEME_BYTES) throw new Error('主题包超过 96MB');
      const staging = await fs.mkdtemp(path.join(this.userRoot, '.import-'));
      try {
        let bytes = 0;
        let files = 0;
        await extractBuddyZip(zipPath, staging, entry => {
          const name = entry.fileName;
          safeBuddyPath(staging, name.replace(/\/$/u, ''));
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('主题包不能包含符号链接');
          if (entry.uncompressedSize > MAX_FILE_BYTES || (bytes += entry.uncompressedSize) > MAX_THEME_BYTES || ++files > 2000) throw new Error('主题包解压大小或文件数量超限');
          if (!name.endsWith('/') && !allowedExtensions.has(path.extname(name).toLowerCase()) && !name.endsWith('/live2dcubismcore.min.js') && name !== 'live2dcubismcore.min.js') throw new Error('主题包包含不支持的文件');
        });
        let root = staging;
        if (!existsSync(path.join(root, 'theme.json'))) {
          const dirs = (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.'));
          if (dirs.length !== 1) throw new Error('主题包需要 theme.json');
          root = path.join(root, dirs[0].name);
        }
        const manifest = parseManifest(readJson(path.join(root, 'theme.json')));
        if (this.#themes.some(t => t.manifest.id === manifest.id) || existsSync(path.join(this.userRoot, manifest.id))) throw new Error('相同标识的角色已存在；请先为新主题更名，不会覆盖旧资源');
        // Validate every path before committing. Source metadata URLs are attribution only.
        const refs = [manifest.model?.model3, manifest.model?.defaultImage, ...Object.values(manifest.model?.staticImages ?? {})].filter((p): p is string => !!p);
        refs.forEach(ref => safeBuddyPath(root, ref));
        const target = path.join(this.userRoot, manifest.id);
        await fs.rename(root, target);
        await atomicJson(path.join(target, '.desktopbuddy-theme.json'), { enabled: true });
        this.#reload();
        const theme = this.#theme(manifest.id);
        if (!theme.ready) {
          await atomicJson(path.join(target, '.desktopbuddy-theme.json'), { enabled: false });
          this.#reload();
          this.#changed();
          throw new Error(theme.issue ?? '导入的角色资源无效，已停用');
        }
        this.#preferences.themeId = manifest.id;
        await atomicJson(this.#settingsPath, this.#preferences);
        return this.#changed();
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    });
  }
  async generate(input: BuddyGeneratedTheme): Promise<BuddySnapshot> {
    return this.#serialize(async () => {
      const analysis = z.object({
        subject: z.string().min(1).max(40), type: z.enum(['human', 'animal', 'plant', 'objectSpirit']),
        characteristics: z.string().max(200), dominantColor: z.string().regex(/^#[0-9a-f]{6}$/iu), secondaryColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
      }).parse(input.analysis);
      const entries = Object.entries(input.frames);
      if (entries.length < 33 || entries.length > 512) throw new Error('主题需要 33–512 个动画帧');
      const id = `generated-${randomUUID()}`;
      const dir = await fs.mkdtemp(path.join(this.userRoot, '.generate-'));
      try {
        let total = 0;
        const images: Record<string, string> = {};
        for (const [key, dataUrl] of entries) {
          if (!/^[a-z0-9_-]{1,80}$/u.test(key) || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(dataUrl)) throw new Error('动画帧格式无效');
          const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
          if (bytes.length > 2 * 1024 * 1024 || (total += bytes.length) > MAX_THEME_BYTES) throw new Error('动画帧数据过大');
          const image = nativeImage.createFromBuffer(bytes);
          const size = image.getSize();
          if (image.isEmpty() || size.width > 1024 || size.height > 1024) throw new Error('动画帧图片无效或超过 1024px');
          images[key] = `${key}.png`;
          await fs.writeFile(path.join(dir, images[key]), bytes, { mode: 0o600 });
        }
        if (!images.idle_0) throw new Error('缺少待机基准帧');
        const manifest = parseManifest({
          schemaVersion: 1, id, displayName: analysis.subject, version: '1.0.0', author: 'User / DesktopBuddy image transforms',
          type: analysis.type, renderer: 'staticImage', description: `本地图片变换生成（非肢体重绘）。${analysis.characteristics}`,
          source: { type: 'local', license: '用户提供图片；请确认图片使用权' },
          layout: { defaultSize: 100, minSize: 50, maxSize: 200, anchor: 'bottomCenter', preferredDock: 'bottomRight' },
          model: { defaultImage: images.idle_0, preview: images.idle_0, staticImages: images },
          colors: { swatches: [analysis.dominantColor, analysis.secondaryColor, '#ffffff'], cssClass: `pet-${id}` },
          capabilities: { idleMotion: true, attention: true, touchReaction: true, dragReaction: true, lifeRoutine: true, ambientMood: true, optionalCare: ['chat', 'play', 'rest'], aiExpression: true, lookAtCursor: true, audioFeedback: false },
          motions: { idleMotion: 'idleMotion', attention: 'attention', touchReaction: 'touchReaction', dragReaction: 'dragReaction', dropReaction: 'drop', lifeRoutine: 'lifeRoutine', optionalCare: 'happy', aiThinking: 'aiThinking', aiSpeaking: 'aiSpeaking', aiSuccess: 'happy', aiError: 'error', aiNeedConfirm: 'confirm', pluginNotify: 'attention' },
          interactions: [{ id: 'touch', label: '摸摸', behavior: 'touchReaction.default', cooldownMs: 800 }, { id: 'play', label: '一起玩', behavior: 'optionalCare.play', cooldownMs: 1000 }, { id: 'rest', label: '休息', behavior: 'lifeRoutine.rest', cooldownMs: 1000 }],
          fallback: { renderer: 'staticImage', motion: { default: 'idleMotion' } },
          animationClips: input.animationClips,
        });
        for (const clip of Object.values(manifest.animationClips ?? {})) if (clip.frames.some(f => !images[f])) throw new Error('生成动作引用了不存在的帧');
        await atomicJson(path.join(dir, 'theme.json'), manifest);
        await fs.rename(dir, path.join(this.userRoot, id));
        this.#preferences.themeId = id;
        await atomicJson(this.#settingsPath, this.#preferences);
        this.#reload();
        return this.#changed();
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    });
  }
  async setEnabled(id: string, enabled: boolean): Promise<BuddySnapshot> {
    return this.#serialize(async () => {
      if (typeof enabled !== 'boolean' || this.#theme(id).origin !== 'user') throw new Error('只能启用或停用自己的主题');
      await atomicJson(path.join(this.userRoot, id, '.desktopbuddy-theme.json'), { enabled });
      this.#reload();
      await atomicJson(this.#settingsPath, this.#preferences);
      return this.#changed();
    });
  }
  async remove(id: string): Promise<BuddySnapshot> {
    return this.#serialize(async () => {
      if (this.#theme(id).origin !== 'user') throw new Error('内置角色不能删除');
      const archive = path.join(this.options.userDataPath, 'pet', 'removed-themes');
      await fs.mkdir(archive, { recursive: true });
      await fs.rename(path.join(this.userRoot, id), path.join(archive, `${id}-${Date.now()}`));
      this.#reload();
      await atomicJson(this.#settingsPath, this.#preferences);
      return this.#changed();
    });
  }
  interact(id: string): BuddyInteraction {
    const theme = this.#theme(this.#preferences.themeId);
    const interaction = theme.manifest.interactions.find(i => i.id === id);
    if (!interaction) throw new Error('这个角色不支持该互动');
    const key = `${theme.manifest.id}:${id}`;
    const now = Date.now();
    if (now - (this.#cooldowns.get(key) ?? 0) < (interaction.cooldownMs ?? 800)) throw new Error('它还在回应，稍等一下');
    this.#cooldowns.set(key, now);
    const event = { themeId: theme.manifest.id, behavior: interaction.behavior, label: interaction.label, at: now };
    this.options.onInteraction?.(event);
    return event;
  }
}
