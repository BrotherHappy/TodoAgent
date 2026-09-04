// Live2D renderer and behavior model adapted from DesktopBuddy (MIT).
// State changes retain the same Cubism model; only a theme change mounts a
// second buffer, held invisible until it has painted a complete frame.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BuddyAssets, BuddyPreferences } from '../../shared/desktopbuddy-contract';
import { defaultBuddyPreferences } from '../../shared/desktopbuddy-contract';
import type { PetBehaviorIntent } from '../../shared/desktopbuddy';
import type { PetPersonality, PetPalette, PetOutfit } from '../../shared/pet-types';
import { petActionLabels, type PetAction, type PetEmotion } from '../pet-behavior';
import type { PetWeatherEffect } from '../pet-weather-effect';
import { buddyActionFromIntent, buddyIntent, resolveBuddyBehavior } from './behavior';
import { createLive2DRenderer, type Live2DRendererController } from './live2d-renderer';
import { loadBuddyAssets, useBuddySnapshot } from './store';
import { buddyActionProgress, createBuddyActionCurve, neutralBuddyPose, sampleBuddyCurve } from './motion-curves';
import { buddyPoster } from './posters';
import './desktopbuddy.css';

interface BuddyCharacterProps {
  themeId?: string;
  action?: PetAction;
  actionKey?: string;
  emotion?: PetEmotion;
  name?: string;
  compact?: boolean;
  scalePercent?: number;
  interactive?: boolean;
  preview?: boolean;
  palette?: PetPalette;
  outfit?: PetOutfit;
  season?: 'spring' | 'summer' | 'autumn' | 'winter';
  weatherEffect?: PetWeatherEffect;
  personality?: PetPersonality;
}

function Live2DSurface({ assets, action, intent, eventKey, retryKey, preferences, onReady, onError }: {
  assets: BuddyAssets; action: PetAction; intent: PetBehaviorIntent; eventKey: string; retryKey: number; preferences: BuddyPreferences; onReady: () => void; onError: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<Live2DRendererController | null>(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const previousRetry = useRef(retryKey);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const errorCallback = useRef(onError); errorCallback.current = onError;
  const resolved = useMemo(() => resolveBuddyBehavior(assets.manifest, intent), [assets, intent]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let owned: Live2DRendererController | undefined;
    let painted = false;
    setStatus('loading'); setError('');
    void createLive2DRenderer(canvas, assets, 100, {
      onFrame: () => {
        if (disposed || painted) return;
        painted = true;
        readyCallback.current();
      },
      onHealth: (health, message) => {
        if (disposed) return;
        setStatus(health); setError(health === 'ready' ? '' : message);
        if (health === 'error') errorCallback.current('动作暂不可用，点击宠物重试');
        if (health === 'ready' && painted) errorCallback.current('');
      },
    }).then(result => {
      if (disposed) { result.controller?.dispose(); return; }
      owned = result.controller;
      controllerRef.current = owned ?? null;
      // A loaded model is not yet a visible pet. Only a successful committed
      // frame from the buffered renderer may activate this theme layer.
      if (!owned) { setStatus(result.status); setError(result.message); errorCallback.current('动作暂不可用，点击宠物重试'); }
    });
    const resize = new ResizeObserver(() => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (rect) owned?.resize(rect.width, rect.height, 100);
    });
    if (canvas.parentElement) resize.observe(canvas.parentElement);
    return () => { disposed = true; resize.disconnect(); owned?.dispose(); controllerRef.current = null; };
  }, [assets, attempt]);
  useEffect(() => {
    if (retryKey === previousRetry.current) return;
    previousRetry.current = retryKey;
    if (controllerRef.current) controllerRef.current.retry?.();
    else setAttempt(value => value + 1);
  }, [retryKey]);
  useEffect(() => {
    if (status !== 'ready') return;
    controllerRef.current?.setAction?.(action, eventKey);
    if (preferences.reducedMotion) return;
    if (resolved.motion) controllerRef.current?.playMotion(resolved.motion, intent.behavior === 'dragReaction' || intent.behavior === 'touchReaction' ? 'interrupt' : 'normal');
    if (resolved.expression) controllerRef.current?.playExpression(resolved.expression);
  }, [status, action, resolved, eventKey, intent.behavior, preferences.reducedMotion]);
  useEffect(() => { controllerRef.current?.setBreathing?.(preferences.breathing); }, [status, preferences.breathing]);
  useEffect(() => {
    controllerRef.current?.setReducedMotion?.(preferences.reducedMotion);
    if (!preferences.cursorFollow || preferences.reducedMotion) { controllerRef.current?.focus(0, 0); return; }
    const follow = (x: number, y: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Smooth normalized Cubism gaze; native focus uses viewport coordinates.
      controllerRef.current?.focus(Math.max(-1, Math.min(1, (x - rect.left - rect.width / 2) / 300)), Math.max(-1, Math.min(1, -(y - rect.top - rect.height / 2) / 300)));
    };
    const pointer = (event: PointerEvent) => follow(event.clientX, event.clientY);
    window.addEventListener('pointermove', pointer, { passive: true });
    const unsubscribe = window.desktopApi?.buddy?.onCursor(({ x, y }) => follow(x, y));
    return () => { window.removeEventListener('pointermove', pointer); unsubscribe?.(); };
  }, [preferences.cursorFollow, preferences.reducedMotion, status]);
  return <>
    <canvas ref={canvasRef} data-buddy-renderer="live2d" data-buddy-status={status} data-buddy-error={error || undefined} />
    {error && status === 'recovering' && <span className="buddy-render-health" role="status" title={error}>动作恢复中</span>}
  </>;
}

const FRAME_GROUPS: Record<string, string[]> = {
  idleMotion: Array.from({ length: 7 }, (_, i) => `idle_${i}`),
  touchReaction: ['touch_0', 'touch_1', 'touch_2'], dragReaction: ['drag_0', 'drag_1', 'drag_2'],
  lifeRoutine: ['sleepy_0', 'sleepy_1', 'sleepy_2'], aiThinking: ['thinking_0', 'thinking_1'],
  aiSpeaking: ['speaking_0', 'speaking_1'], aiSuccess: ['happy_0', 'happy_1'],
  optionalCare: ['happy_0', 'happy_1'], aiError: ['error'], aiNeedConfirm: ['confirm'], attention: ['attention', 'attention_look'],
};
function StaticSurface({ assets, action, intent, eventKey, retryKey, preferences, onReady, onError }: {
  assets: BuddyAssets; action: PetAction; intent: PetBehaviorIntent; eventKey: string; retryKey: number; preferences: BuddyPreferences; onReady: () => void; onError: (message: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const current = useRef({ action, intent, eventKey, preferences });
  current.current = { action, intent, eventKey, preferences };
  const ready = useRef(onReady); ready.current = onReady;
  const errorCallback = useRef(onError); errorCallback.current = onError;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    setFailed(false);
    let disposed = false, frame = 0, tick = 0;
    const images = new Map<string, HTMLImageElement>();
    const buffers = [document.createElement('canvas'), document.createElement('canvas')];
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = Math.round(256 * dpr);
    canvas.width = canvas.height = size;
    buffers.forEach(buffer => { buffer.width = buffer.height = size; });
    const context = canvas.getContext('2d');
    const front = buffers[0].getContext('2d'), back = buffers[1].getContext('2d');
    if (!context || !front || !back) return;
    const sources = { ...assets.staticImages, __default__: assets.staticImageUrl };
    let lastAction = '', began = 0, handoff = 0;
    const load = async () => {
      await Promise.all(Object.entries(sources).map(async ([key, src]) => {
        if (!src) return;
        const image = new Image(); image.src = src;
        await image.decode();
        images.set(key, image);
      }));
      if (disposed) return;
      const draw = (now: number) => {
        const state = current.current;
        if (lastAction !== `${state.action}:${state.intent.behavior}:${state.intent.variant}:${state.eventKey}`) {
          back.globalCompositeOperation = 'copy'; back.drawImage(canvas, 0, 0);
          lastAction = `${state.action}:${state.intent.behavior}:${state.intent.variant}:${state.eventKey}`;
          began = now; handoff = tick > 0 ? now : -1;
        }
        const clip = assets.manifest.animationClips?.[state.action];
        const mapping = resolveBuddyBehavior(assets.manifest, state.intent).motion;
        let keys = clip?.frames ?? FRAME_GROUPS[mapping ?? ''] ?? FRAME_GROUPS[state.intent.behavior] ?? [mapping ?? 'idle_0'];
        if (state.intent.variant === 'sleep') keys = ['sleep', 'sleep_breathe'];
        keys = keys.filter(key => images.has(key));
        if (!keys.length) keys = [images.has('idle_0') ? 'idle_0' : '__default__'];
        const duration = clip ? 1000 / clip.fps : state.intent.behavior === 'idleMotion' ? 2200 : 350;
        const pos = state.preferences.reducedMotion ? 0 : (now - began) / duration;
        const index = clip?.loop === false ? Math.min(keys.length - 1, Math.floor(pos)) : Math.floor(pos) % keys.length;
        const next = clip?.loop === false ? Math.min(keys.length - 1, index + 1) : (index + 1) % keys.length;
        const image = images.get(keys[index]);
        const blend = .5 - .5 * Math.cos(Math.PI * (pos % 1));
        front.clearRect(0, 0, size, size);
        front.globalAlpha = next !== index ? 1 - blend : 1;
        if (image) front.drawImage(image, 0, 0, size, size);
        // Double buffering commits a complete composed frame on a single
        // visible canvas. No CSS opacity toggle can expose an empty buffer.
        if (next !== index) {
          const nextImage = images.get(keys[next]);
          if (nextImage) { front.globalCompositeOperation = 'lighter'; front.globalAlpha = blend; front.drawImage(nextImage, 0, 0, size, size); }
        }
        front.globalAlpha = 1; front.globalCompositeOperation = 'source-over';
        context.globalCompositeOperation = 'copy'; context.drawImage(buffers[0], 0, 0);
        context.globalCompositeOperation = 'source-over';
        if (handoff >= 0 && now - handoff < 180 && !state.preferences.reducedMotion) {
          context.globalAlpha = 1 - (now - handoff) / 180; context.drawImage(buffers[1], 0, 0); context.globalAlpha = 1;
        }
        canvas.dataset.buddyFrame = String(++tick);
        canvas.dataset.buddyCell = String(index);
        if (tick === 1) ready.current();
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    };
    void load().catch(() => { if (!disposed) { setFailed(true); errorCallback.current('图片主题加载失败，请选择其他角色后重试'); } });
    return () => { disposed = true; cancelAnimationFrame(frame); images.clear(); };
  }, [assets, retryKey]);
  return <><canvas ref={ref} data-buddy-renderer="staticImage" data-render-path="double-buffer" />{failed && <span className="buddy-render-error">图片主题加载失败</span>}</>;
}

function BuddyLayer({ assets, action, intent, eventKey, retryKey, preferences, onReady, onError, active, retained, onlyModel }: {
  assets: BuddyAssets; action: PetAction; intent: PetBehaviorIntent; eventKey: string; retryKey: number; preferences: BuddyPreferences; onReady: () => void; onError: (message: string) => void; active: boolean; retained: boolean; onlyModel: boolean;
}) {
  return <span className={`buddy-theme-layer ${active ? 'is-active' : ''} ${retained && !active ? 'is-retained' : ''} ${onlyModel ? 'is-only-model' : ''}`} data-buddy-theme={assets.themeId}>
    {assets.renderer === 'live2d'
      ? <Live2DSurface assets={assets} action={action} intent={intent} eventKey={eventKey} retryKey={retryKey} preferences={preferences} onReady={onReady} onError={onError} />
      : <StaticSurface assets={assets} action={action} intent={intent} eventKey={eventKey} retryKey={retryKey} preferences={preferences} onReady={onReady} onError={onError} />}
  </span>;
}

export function BuddyCharacter({ themeId, action = 'idle', actionKey, emotion = 'calm', name = '小序', compact, scalePercent = 100, interactive, preview, palette = 'lavender', outfit = 'none', season, weatherEffect, personality = 'gentle' }: BuddyCharacterProps) {
  const snapshot = useBuddySnapshot();
  const selectedId = themeId ?? snapshot?.preferences.themeId ?? defaultBuddyPreferences.themeId;
  const preferences = snapshot?.preferences ?? defaultBuddyPreferences;
  const [layers, setLayers] = useState<BuddyAssets[]>([]);
  const [activeId, setActiveId] = useState('');
  const [override, setOverride] = useState<{ intent: PetBehaviorIntent; key: string }>();
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const bodyRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const ropeRef = useRef<SVGPathElement>(null);
  const ropeBackRef = useRef<SVGPathElement>(null);
  const activeOverride = ['drag', 'approve', 'sync-error', 'agent-error'].includes(action) ? undefined : override;
  const visualAction = activeOverride ? buddyActionFromIntent(activeOverride.intent) : action;
  const eventKey = activeOverride?.key ?? actionKey ?? action;
  const actionRef = useRef(visualAction); actionRef.current = visualAction;
  const eventRef = useRef(eventKey); eventRef.current = eventKey;
  const prefsRef = useRef(preferences); prefsRef.current = preferences;
  const layersRef = useRef(layers); layersRef.current = layers;
  const readyAssets = useRef(new WeakSet<BuddyAssets>());
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const retireTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const velocity = useRef({ x: 0, y: 0 });
  const [reducedBySystem, setReducedBySystem] = useState(false);
  const effectivePreferences = useMemo(() => ({ ...preferences, reducedMotion: preferences.reducedMotion || reducedBySystem }), [preferences, reducedBySystem]);
  prefsRef.current = effectivePreferences;
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedBySystem(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    let cancelled = false;
    clearTimeout(retireTimer.current);
    setError('');
    void loadBuddyAssets(selectedId).then(assets => {
      if (cancelled) return;
      // Retain the painted model, not the last (possibly still loading) one.
      // Re-selecting an already painted layer must not wait for another load.
      const existing = layersRef.current.find(layer => layer.themeId === assets.themeId);
      setLayers(previous => {
        const retained = previous.filter(layer => layer.themeId === activeRef.current || layer.themeId === assets.themeId);
        return retained.some(layer => layer.themeId === assets.themeId) ? retained : [...retained, assets];
      });
      if (existing && readyAssets.current.has(existing)) onReady(existing);
    }).catch(() => { if (!cancelled) setError('角色资源读取失败，请在设置中重新选择'); });
    return () => { cancelled = true; };
  }, [selectedId, retryKey]);
  useEffect(() => () => clearTimeout(retireTimer.current), []);
  useEffect(() => {
    if (!error) return;
    // Native dragging captures the pointer on the outer avatar button. Its
    // click target is then that button, not the inner character span. Listen
    // there in the capture phase so retry also works with drag/keyboard input.
    const target = rootRef.current?.closest('.pet-avatar-button') ?? rootRef.current;
    const retry = (event: Event) => { event.preventDefault(); event.stopPropagation(); setRetryKey(value => value + 1); };
    target?.addEventListener('click', retry, true);
    return () => target?.removeEventListener('click', retry, true);
  }, [error]);
  useEffect(() => {
    if (preview) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const off = window.desktopApi?.buddy?.onInteraction(event => {
      if (event.themeId !== selectedRef.current) return;
      const [behavior, variant] = event.behavior.split('.');
      setOverride({ intent: { behavior: behavior as PetBehaviorIntent['behavior'], variant }, key: String(event.at) });
      clearTimeout(timeout);
      timeout = setTimeout(() => setOverride(undefined), event.behavior.includes('rest') ? 9000 : 2400);
    });
    const cursor = window.desktopApi?.buddy?.onCursor(event => { velocity.current = { x: event.velocityX, y: event.velocityY }; });
    return () => { off?.(); cursor?.(); clearTimeout(timeout); };
  }, [preview]);
  useEffect(() => {
    let frame = 0, previousTime = 0, started = 0, lastAction = '', lastKey = '';
    let curve = createBuddyActionCurve(actionRef.current);
    let pose = { ...neutralBuddyPose };
    const tick = (now: number) => {
      const currentAction = actionRef.current;
      if (lastAction !== currentAction || lastKey !== eventRef.current) { lastAction = currentAction; lastKey = eventRef.current; started = now; curve = createBuddyActionCurve(currentAction); }
      const prefs = prefsRef.current;
      const progress = buddyActionProgress(currentAction, now - started);
      const hasBakedCurve = !!layersRef.current.find(layer => layer.themeId === selectedRef.current)?.manifest.animationClips?.[currentAction];
      const target = hasBakedCurve || prefs.reducedMotion ? { ...neutralBuddyPose } : sampleBuddyCurve(curve, progress);
      if (!prefs.reducedMotion && prefs.breathing && currentAction !== 'drag') {
        target.y += Math.sin(now / 1600) * .7;
        target.scaleY *= 1 + Math.sin(now / 1600) * .005;
      }
      if (currentAction === 'drag' && !prefs.reducedMotion) {
        target.rotation += Math.max(-12, Math.min(12, velocity.current.x * 2.5));
        target.scaleY += Math.min(.07, Math.abs(velocity.current.y) * .01);
      }
      const dt = Math.min(50, previousTime ? now - previousTime : 16); previousTime = now;
      const blend = prefs.reducedMotion ? 1 : 1 - Math.exp(-dt / (currentAction === 'jump-rope' ? 20 : 85));
      for (const key of Object.keys(pose) as (keyof typeof pose)[]) pose[key] += (target[key] - pose[key]) * blend;
      if (bodyRef.current) bodyRef.current.style.transform = `translate(${pose.x}%, ${pose.y}%) rotate(${pose.rotation}deg) scale(${pose.scaleX}, ${pose.scaleY})`;
      if ((currentAction === 'jump-rope' || currentAction === 'jump-rope-ready') && !prefs.reducedMotion) {
        const phase = currentAction === 'jump-rope-ready' ? 0 : progress * Math.PI * 2;
        const y = 76 + pose.y;
        const arc = currentAction === 'jump-rope-ready' ? 77 : Math.cos(phase) * 77;
        const d = `M18 ${y} C-3 ${y - arc} 103 ${y - arc} 82 ${y}`;
        const front = currentAction === 'jump-rope-ready' || Math.sin(phase) < 0;
        ropeRef.current?.setAttribute('d', d); ropeBackRef.current?.setAttribute('d', d);
        ropeRef.current?.setAttribute('opacity', front ? '1' : '0'); ropeBackRef.current?.setAttribute('opacity', front ? '0' : '1');
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  const intent = useMemo(() => activeOverride?.intent ?? buddyIntent(action), [action, activeOverride]);
  const onReady = (assets: BuddyAssets) => {
    const id = assets.themeId;
    readyAssets.current.add(assets);
    if (selectedRef.current !== id) return;
    activeRef.current = id;
    setActiveId(id);
    setError('');
    clearTimeout(retireTimer.current);
    retireTimer.current = setTimeout(() => {
      if (selectedRef.current === id) setLayers(previous => previous.filter(layer => layer.themeId === id));
    }, 220);
  };
  return <span ref={rootRef}
    className={`pet-character buddy-character pet-palette-${palette} pet-outfit-${outfit} pet-personality-${personality} ${season ? `pet-season-${season}` : ''} ${weatherEffect ? `pet-weather-${weatherEffect}` : ''} ${compact ? 'is-compact' : ''} ${interactive ? 'is-interactive' : ''} ${preview ? 'buddy-preview' : ''}`}
    style={{ '--pet-scale': Math.min(1.25, Math.max(.75, scalePercent / 100)) } as CSSProperties}
    role="img" aria-label={`${name}，${petActionLabels[visualAction]}，${emotion}${error ? `，${error}` : ''}`}
    title={error || undefined}
    data-pet-action={visualAction} data-pet-action-key={eventKey} data-pet-emotion={emotion} data-pet-palette={palette} data-pet-outfit={outfit} data-pet-weather-effect={weatherEffect ?? 'clear'} data-pet-personality={personality} data-pet-visual-style="desktopbuddy" data-buddy-active={activeId}>
    {(action === 'jump-rope' || action === 'jump-rope-ready') && <svg className="buddy-rope buddy-rope-back" viewBox="0 0 100 110" aria-hidden="true"><path ref={ropeBackRef} /></svg>}
    <span ref={bodyRef} className="buddy-character-body">
      {!activeId && <img className="buddy-poster" src={buddyPoster(selectedId)} alt="" aria-hidden="true" data-buddy-fallback="poster" />}
      {layers.map(assets => <BuddyLayer key={assets.themeId} assets={assets} action={visualAction} intent={intent} eventKey={eventKey} retryKey={retryKey} preferences={effectivePreferences} onReady={() => onReady(assets)} onError={message => { if (selectedRef.current === assets.themeId) setError(message); }} active={assets.themeId === activeId} retained={readyAssets.current.has(assets)} onlyModel={layers.length === 1} />)}
      {error && <span className="buddy-render-health" role="status">{error}</span>}
    </span>
    {(action === 'jump-rope' || action === 'jump-rope-ready') && <svg className="buddy-rope buddy-rope-front" viewBox="0 0 100 110" aria-hidden="true"><path ref={ropeRef} /></svg>}
    {action === 'pet' && <span className="buddy-touch-spark" aria-hidden="true">♡</span>}
    {(action === 'task-carry' || action === 'task-complete') && <svg className="buddy-task-card" viewBox="0 0 28 32" aria-hidden="true"><rect x="1" y="1" width="26" height="30" rx="4" /><path d="m7 16 4 4 10-10M7 25h14" /></svg>}
  </span>;
}
