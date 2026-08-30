import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import type { PetPersonality } from "../shared/pet-types";
import type { PetWeatherEffect } from "./pet-weather-effect";
import {
  petActionLabels,
  type PetAction,
  type PetEmotion,
} from "./pet-behavior";
import {
  petAtlasAnimationForAction,
  petAtlasFrameFromIndex,
  petAtlasFrameForAction,
  petAtlasUrlForSheet,
} from "./pet-atlas";

export type PetMood = "idle" | "focus" | "syncing" | "alert" | "happy";
export type PetPalette = "lavender" | "mint" | "sunset" | "midnight";
export type PetOutfit = "none" | "scarf" | "explorer" | "starlight";
export type PetSeason = "spring" | "summer" | "autumn" | "winter";
/** Original visual treatment inspired by desktop-pet pixel silhouettes. */
export type PetVisualStyle = "pixel" | "soft" | "atlas";
export type { PetPersonality };

interface PetCharacterProps {
  mood?: PetMood;
  emotion?: PetEmotion;
  action?: PetAction;
  name?: string;
  scalePercent?: number;
  compact?: boolean;
  interactive?: boolean;
  palette?: PetPalette;
  outfit?: PetOutfit;
  season?: PetSeason;
  weatherEffect?: PetWeatherEffect;
  personality?: PetPersonality;
  visualStyle?: PetVisualStyle;
}

const moodLabels: Record<PetMood, string> = {
  idle: "正在陪伴你",
  focus: "正在和你一起专注",
  syncing: "正在同步任务",
  alert: "有一件事需要留意",
  happy: "为你的进展开心",
};

const moodEmotion: Record<PetMood, PetEmotion> = {
  idle: "calm",
  focus: "focused",
  syncing: "focused",
  alert: "concerned",
  happy: "happy",
};

const emotionLabels: Record<PetEmotion, string> = {
  calm: "平静",
  curious: "好奇",
  happy: "开心",
  excited: "兴奋",
  focused: "专注",
  sleepy: "困倦",
  concerned: "有些担心",
  proud: "很有成就感",
};

const personalityLabels: Record<PetPersonality, string> = {
  gentle: "温柔陪伴",
  energetic: "元气鼓励",
  calm: "冷静管家",
  playful: "活泼淘气",
  witty: "轻微淘气",
  quiet: "安静陪伴",
};

function clampGaze(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

interface PetAtlasCanvasProps {
  src: string;
  animation: ReturnType<typeof petAtlasAnimationForAction>;
  onStep: (step: number) => void;
  onReady?: (ready: boolean) => void;
}

// There are only two runtime sheets. Keep their decoded Image objects alive
// for the lifetime of the renderer so switching from idle → focus → pet can
// restart the timeline without showing an empty canvas while the same PNG is
// decoded again.
const petAtlasImageCache = new Map<string, HTMLImageElement>();
const petAtlasImageLoads = new Map<string, Promise<HTMLImageElement>>();
let petAtlasWarmupTimer: number | undefined;

function loadPetAtlasImage(src: string): Promise<HTMLImageElement> {
  const cached = petAtlasImageCache.get(src);
  if (cached) return Promise.resolve(cached);
  const loading = petAtlasImageLoads.get(src);
  if (loading) return loading;
  const image = new Image();
  image.decoding = "async";
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => {
      // `load` means the bytes arrived, not necessarily that Chromium has
      // decoded the multi-megabyte atlas texture. Waiting for decode here moves that
      // work off the first animation tick, preventing a long first-frame hitch
      // when the user switches from the motion sheet to an interaction sheet.
      const decoded = typeof image.decode === "function"
        ? image.decode().catch(() => undefined)
        : Promise.resolve();
      void decoded.then(() => {
        petAtlasImageCache.set(src, image);
        petAtlasImageLoads.delete(src);
        resolve(image);
      });
    };
    image.onerror = () => {
      petAtlasImageLoads.delete(src);
      reject(new Error(`Failed to load pet atlas: ${src}`));
    };
  });
  petAtlasImageLoads.set(src, promise);
  image.src = src;
  return promise;
}

function schedulePetAtlasWarmup(): void {
  if (typeof window === "undefined" || petAtlasWarmupTimer !== undefined) return;
  petAtlasWarmupTimer = window.setTimeout(() => {
    petAtlasWarmupTimer = undefined;
    // Decode both local sheets shortly after the first pet mounts. Waiting a
    // full idle window made a fast first click race the interaction
    // texture, so the pet could finish its short head-pat before the atlas
    // ever produced a frame. A short defer still lets the motion canvas paint
    // its first fallback frame while making the first interaction warm.
    void loadPetAtlasImage(petAtlasUrlForSheet("motion")).catch(() => undefined);
    void loadPetAtlasImage(petAtlasUrlForSheet("interaction")).catch(() => undefined);
  }, 100);
}

/**
 * Blend two complete canvas frames in premultiplied-alpha space. Keeping the
 * alpha envelope to the larger of the two contributions prevents a brief
 * translucent "double pet" when an interaction sheet replaces a motion
 * sheet, while still giving the eye a few display beats to follow the pose.
 */
function blendPetAtlasFrames(
  from: ImageData,
  to: ImageData,
  progress: number,
): ImageData {
  const t = Math.max(0, Math.min(1, progress));
  const output = new ImageData(from.width, from.height);
  const source = from.data;
  const target = to.data;
  const result = output.data;
  for (let index = 0; index < result.length; index += 4) {
    const fromAlpha = source[index + 3] / 255;
    const toAlpha = target[index + 3] / 255;
    const fromWeight = fromAlpha * (1 - t);
    const toWeight = toAlpha * t;
    const weight = fromWeight + toWeight;
    if (weight <= 0.0001) continue;
    const envelope = Math.max(fromWeight, toWeight);
    result[index + 3] = Math.round(envelope * 255);
    result[index] = Math.round(
      (source[index] * fromWeight + target[index] * toWeight) / weight,
    );
    result[index + 1] = Math.round(
      (source[index + 1] * fromWeight + target[index + 1] * toWeight) / weight,
    );
    result[index + 2] = Math.round(
      (source[index + 2] * fromWeight + target[index + 2] * toWeight) / weight,
    );
  }
  return output;
}

/**
 * Paint atlas cells on a canvas on the display refresh cadence. Updating a
 * CSS transform from a timer can land between compositor frames and expose a
 * one-pixel seam from the neighboring cell. Canvas source-rect drawing keeps
 * the cell boundary exact. Frames are swapped atomically instead of
 * cross-fading complete silhouettes: two overlapping transparent pets read as
 * a tearing tail/ear, especially during carrying and rope actions.
 */
function PetAtlasCanvas({ src, animation, onStep, onReady }: PetAtlasCanvasProps) {
  const stackRef = useRef<HTMLSpanElement>(null);
  const imageRef = useRef<HTMLImageElement | undefined>(undefined);
  const animationKey = `${src}:${animation.name}:${animation.frames.length}:${animation.frames[0] ?? 0}`;
  const previousAnimationKeyRef = useRef(animationKey);
  // A state change (idle → pet, work → celebrate, etc.) used to reveal the
  // first frame of the new sheet in one compositor tick. Even with a double
  // buffer that is a complete frame, but it is still a visible teleport when
  // the two authored poses have different props. Capture the last presented
  // pixels before React swaps the animation and let the next paint perform a
  // very short, pixel-complete handoff. The bridge is intentionally only a
  // few display beats; it removes the hard cut without leaving two full pets
  // on screen long enough to read as a duplicate.
  const handoffRef = useRef<ImageData | undefined>(undefined);
  // Once one complete canvas frame has reached the screen, keep that frame
  // visible while a different sheet is decoding. Falling back to the SVG on
  // every motion → interaction switch briefly rendered two different pets
  // in the same bounds and read as a teleport. The SVG fallback is reserved
  // for the true cold-start/error path where no canvas frame exists yet.
  const presentedFrameRef = useRef(false);
  // Action changes keep the same canvas mounted. When an atlas has already
  // been decoded, start the new timeline immediately instead of painting a
  // one-frame empty canvas while the `ready` state catches up.
  const [ready, setReady] = useState(() => petAtlasImageCache.has(src));

  useLayoutEffect(() => {
    if (previousAnimationKeyRef.current === animationKey) return;
    const stack = stackRef.current;
    const activeBuffer = stack?.dataset.activeBuffer === "1" ? 1 : 0;
    const activeCanvas = stack?.querySelector<HTMLCanvasElement>(
      `.pet-atlas-buffer-${activeBuffer}`,
    );
    const context = activeCanvas?.getContext("2d");
    if (activeCanvas && context && activeCanvas.width > 0 && activeCanvas.height > 0 && presentedFrameRef.current) {
      try {
        handoffRef.current = context.getImageData(
          0,
          0,
          activeCanvas.width,
          activeCanvas.height,
        );
      } catch {
        // Security restrictions or an unavailable canvas should not prevent
        // the atlas from playing; the new animation still starts atomically.
        handoffRef.current = undefined;
      }
    }
    previousAnimationKeyRef.current = animationKey;
  }, [animationKey]);

  useEffect(() => {
    let cancelled = false;
    // Start the sibling-sheet warmup as soon as the first atlas renderer is
    // mounted. This runs in parallel with the current sheet's decode and
    // removes a cold-start race when the user opens the interaction wheel
    // immediately after launching the floating pet.
    schedulePetAtlasWarmup();
    const cached = petAtlasImageCache.get(src);
    if (cached) {
      imageRef.current = cached;
      setReady(true);
      schedulePetAtlasWarmup();
    } else {
      if (!presentedFrameRef.current) onReady?.(false);
      loadPetAtlasImage(src)
        .then((image) => {
          if (cancelled) return;
          imageRef.current = image;
          setReady(true);
          schedulePetAtlasWarmup();
        })
        .catch(() => {
          if (!cancelled) {
            setReady(false);
            // Keep the last complete canvas pose on a sheet failure. Showing
            // the SVG at this point would overlap the retained canvas; a
            // later retry can still replace it atomically when the sheet is
            // available again. On true cold start, expose the SVG fallback.
            if (!presentedFrameRef.current) onReady?.(false);
          }
        });
    }
    return () => {
      cancelled = true;
      imageRef.current = undefined;
      setReady(false);
      // Do not demote a visible canvas to the SVG fallback during an action
      // switch. The new sheet will paint into the hidden buffer first and
      // then flip it into view as one complete frame.
      if (!presentedFrameRef.current) onReady?.(false);
    };
  }, [onReady, src]);

  useEffect(() => {
    if (!ready) return undefined;
    const stack = stackRef.current;
    const canvases = stack
      ? Array.from(stack.querySelectorAll("canvas"))
      : [];
    const image = imageRef.current;
    if (!stack || canvases.length < 2 || !image) return undefined;
    const contexts = canvases
      .map((canvas) => canvas.getContext("2d", { alpha: true }));
    if (contexts.some((context) => !context)) return undefined;
    // Keep the normal compositor/vsync path for sprite animation. Chromium's
    // `desynchronized` hint is useful for low-latency video, but can expose a
    // surface between paints under load; a desktop pet should prefer a fully
    // presented cell over shaving a few milliseconds of latency.
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const resize = (): void => {
      const cssWidth = canvases[0]?.clientWidth || 256;
      const cssHeight = canvases[0]?.clientHeight || cssWidth;
      const width = Math.max(1, Math.round(cssWidth * dpr));
      const height = Math.max(1, Math.round(cssHeight * dpr));
      canvases.forEach((canvas, index) => {
        if (canvas.width === width && canvas.height === height) return;
        canvas.width = width;
        canvas.height = height;
        const context = contexts[index];
        if (!context) return;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
      });
    };
    resize();
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(resize) : undefined;
    resizeObserver?.observe(canvases[0]);

    const frameCount = Math.max(1, animation.frames.length);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const shouldLoop = animation.loop && !reduceMotion;
    // A forward-only loop snaps from the last generated pose back to the
    // first one. Traverse the sequence back-and-forth instead; this doubles
    // the usable motion beats without inventing a discontinuous reset frame.
    const travelCount = shouldLoop && frameCount > 1
      ? frameCount * 2 - 2
      : frameCount;
    // Observe the compositor cadence so long background pauses can be capped
    // without making the playhead jump. The atlas frame duration remains the
    // source of truth: dense 8ms sequences must advance two logical cells on
    // a 60Hz display, otherwise hundreds of offline in-betweens turn into a
    // visibly slow flipbook.
    let refreshQuantum = 1000 / 60;
    const refreshSamples: number[] = [];
    const observeRefresh = (delta: number): void => {
      if (!Number.isFinite(delta) || delta < 4 || delta > 60) return;
      refreshSamples.push(delta);
      if (refreshSamples.length > 8) refreshSamples.shift();
      if (refreshSamples.length < 3) return;
      const sorted = [...refreshSamples].sort((a, b) => a - b);
      const middle = sorted[Math.floor(sorted.length / 2)] ?? refreshQuantum;
      // Round noisy compositor samples to a stable cadence while keeping
      // support for high-refresh panels. The 4–60ms bounds reject background
      // throttling and long GC pauses from changing the animation speed.
      refreshQuantum = Math.max(1000 / 240, Math.min(1000 / 30, middle));
    };
    const authoredFrameDuration = Math.max(1, animation.frameDurationMs);
    // Keep a fractional playhead instead of rounding to a cell at every
    // refresh. At 60Hz an 8ms atlas advances about two cells, but the hidden
    // buffer also blends the fractional remainder into the next cell. That
    // gives the compositor a genuinely new pose on every refresh instead of
    // presenting a 2-cell flipbook.
    let sequencePosition = 0;
    let sequenceStarted = false;
    const cellWidth = image.naturalWidth / Math.max(1, animation.columns);
    const cellHeight = image.naturalHeight / Math.max(1, animation.rows);
    let previousTimestamp: number | undefined;
    let lastStep = -1;
    let frameRequest = 0;

    const drawFrame = (
      context: CanvasRenderingContext2D,
      canvas: HTMLCanvasElement,
      frameIndex: number,
      alpha = 1,
    ): void => {
      const safeFrame = Math.max(0, Math.min(animation.columns * animation.rows - 1, frameIndex));
      const sourceX = (safeFrame % animation.columns) * cellWidth;
      const sourceY = Math.floor(safeFrame / animation.columns) * cellHeight;
      // Atlas cells are packed without a gutter. Sampling exactly on a cell
      // boundary lets a filtered texture fetch one pixel from the neighbour,
      // which shows up as a one-frame tail/ear seam on scaled pets. Inset the
      // source rectangle by one source pixel so bilinear filtering can never
      // read the adjacent pose; the transparent margin around the character
      // keeps this crop visually lossless.
      const sourceInset = Math.min(1, cellWidth / 8, cellHeight / 8);
      const sourceWidth = Math.max(1, cellWidth - sourceInset * 2);
      const sourceHeight = Math.max(1, cellHeight - sourceInset * 2);
      context.globalAlpha = Math.max(0, Math.min(1, alpha));
      context.drawImage(
        image,
        sourceX + sourceInset,
        sourceY + sourceInset,
        sourceWidth,
        sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    };

    // Paint into the hidden buffer, then flip the two complete canvases. A
    // single visible canvas can be sampled between clearRect/drawImage on a
    // busy desktop compositor; the double buffer makes every presented pose
    // complete, so ears, tails and rope strokes cannot tear independently.
    // Preserve whichever buffer is currently visible when an action or sheet
    // changes. Resetting to buffer 0 unconditionally can expose an older pose
    // for one compositor tick before the new hidden frame is painted.
    let activeBuffer = stack.dataset.activeBuffer === "1" ? 1 : 0;
    let firstFramePainted = false;
    if (!stack.dataset.activeBuffer) stack.dataset.activeBuffer = String(activeBuffer);
    // Keep the bridge short enough that it reads as a soft handoff rather
    // than a ghosting effect. Five display beats are ~42ms at 120Hz and
    // ~83ms at 60Hz, long enough to remove a hard cut while keeping the new
    // action immediate.
    let handoffFrom = handoffRef.current;
    handoffRef.current = undefined;
    let handoffFrame = handoffFrom ? 0 : 5;
    const handoffFrameCount = 5;
    if (
      handoffFrom &&
      (handoffFrom.width !== canvases[0].width || handoffFrom.height !== canvases[0].height)
    ) {
      handoffFrom = undefined;
      handoffFrame = handoffFrameCount;
    }
    stack.dataset.handoff = handoffFrom ? "true" : "false";

    const paint = (now: number): void => {
      // Do not fast-forward across a long main-thread/compositor pause. Keep
      // at most two refresh intervals of time and at most four adjacent atlas
      // cells per paint. The fractional playhead below turns the remainder
      // into a cross-faded pose, so a 60Hz display never looks like it is
      // dropping every other generated cell.
      if (previousTimestamp === undefined) previousTimestamp = now;
      const delta = Math.max(0, now - previousTimestamp);
      previousTimestamp = now;
      observeRefresh(delta);
      if (!sequenceStarted) {
        sequenceStarted = true;
      } else {
        const cappedDelta = Math.min(
          Math.max(refreshQuantum * 2, 1),
          Math.max(0, delta),
        );
        const positionAdvance = Math.min(4, cappedDelta / authoredFrameDuration);
        if (shouldLoop) {
          sequencePosition = (sequencePosition + positionAdvance) % travelCount;
        } else {
          sequencePosition = Math.min(travelCount - 1, sequencePosition + positionAdvance);
        }
      }
      const currentPosition = Math.max(0, Math.min(travelCount - 1, sequencePosition));
      const currentIndex = Math.floor(currentPosition);
      const fractionalProgress = shouldLoop || currentIndex < travelCount - 1
        ? currentPosition - currentIndex
        : 0;
      const frameAt = (position: number): number => {
        const wrapped = shouldLoop
          ? ((position % travelCount) + travelCount) % travelCount
          : Math.max(0, Math.min(travelCount - 1, position));
        const step = animation.loop && wrapped >= frameCount
          ? travelCount - wrapped
          : wrapped;
        return animation.frames[Math.floor(step)] ?? animation.frames[0] ?? 0;
      };
      const current = frameAt(currentIndex);
      const next = frameAt(currentIndex + 1);
      const step = currentIndex;

      resize();
      const nextBuffer = activeBuffer === 0 ? 1 : 0;
      const nextCanvas = canvases[nextBuffer];
      const nextContext = contexts[nextBuffer];
      if (!nextCanvas || !nextContext) return;
      // Draw the complete fractional pose into the hidden surface before the
      // one-attribute buffer flip. Adjacent offline cells are already contour
      // neighbours, so this short premultiplied canvas cross-fade removes the
      // remaining 60Hz stepping without creating a second visible pet.
      nextContext.globalCompositeOperation = "copy";
      nextContext.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
      drawFrame(nextContext, nextCanvas, current, 1 - fractionalProgress);
      if (fractionalProgress > 0.0001 && next !== current) {
        nextContext.globalCompositeOperation = "source-over";
        drawFrame(nextContext, nextCanvas, next, fractionalProgress);
      }
      nextContext.globalCompositeOperation = "source-over";
      nextContext.globalAlpha = 1;
      if (handoffFrom && handoffFrame < handoffFrameCount) {
        try {
          const targetFrame = nextContext.getImageData(
            0,
            0,
            nextCanvas.width,
            nextCanvas.height,
          );
          const progress = (handoffFrame + 1) / handoffFrameCount;
          const blended = blendPetAtlasFrames(handoffFrom, targetFrame, progress);
          nextContext.putImageData(blended, 0, 0);
          handoffFrame += 1;
          if (handoffFrame >= handoffFrameCount) {
            handoffFrom = undefined;
            stack.dataset.handoff = "false";
          }
        } catch {
          // If readback is unavailable, keep the already complete target
          // frame. The double buffer still guarantees an atomic presentation.
          handoffFrom = undefined;
          handoffFrame = handoffFrameCount;
          stack.dataset.handoff = "false";
        }
      }
      // The hidden buffer is fully painted before this one-attribute flip.
      // CSS only changes opacity; no intermediate pixels are exposed.
      stack.dataset.activeBuffer = String(nextBuffer);
      activeBuffer = nextBuffer;
      if (!firstFramePainted) {
        firstFramePainted = true;
        presentedFrameRef.current = true;
        // Keep the SVG fallback visible until a complete canvas frame has
        // actually been presented. Image decode completion alone can still
        // precede the first rAF paint by one compositor tick.
        onReady?.(true);
      }
      if (step !== lastStep) {
        lastStep = step;
        onStep(step);
      }

      if (!shouldLoop && sequencePosition >= travelCount - 1) {
        frameRequest = 0;
        return;
      }
      frameRequest = window.requestAnimationFrame(paint);
    };

    frameRequest = window.requestAnimationFrame(paint);
    return () => {
      if (frameRequest) window.cancelAnimationFrame(frameRequest);
      resizeObserver?.disconnect();
      contexts.forEach((context) => {
        if (!context) return;
        context.globalCompositeOperation = "source-over";
        context.globalAlpha = 1;
      });
    };
  }, [animation, onReady, onStep, ready]);

  return (
    <span ref={stackRef} className="pet-atlas-buffer-stack" data-active-buffer="0">
      <canvas className="pet-atlas-canvas pet-atlas-motion pet-atlas-buffer-0" aria-hidden="true" data-ready={ready ? "true" : "false"} />
      <canvas className="pet-atlas-canvas pet-atlas-motion pet-atlas-buffer-1" aria-hidden="true" data-ready={ready ? "true" : "false"} />
    </span>
  );
}

/**
 * The mascot combines generated frame-by-frame loops with the articulated
 * SVG rig kept below as a fallback and for precise interaction overlays. A
 * business state therefore changes both the pet's pose and its motion rhythm.
 */
export function PetCharacter({
  mood = "idle",
  emotion,
  action = "idle",
  name = "小序",
  scalePercent = 100,
  compact = false,
  interactive = false,
  palette = "lavender",
  outfit = "none",
  season,
  weatherEffect,
  personality = "gentle",
  visualStyle = "pixel",
}: PetCharacterProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const gradientId = `pet-body-${useId().replaceAll(":", "")}`;
  const bellyGradientId = `pet-belly-${useId().replaceAll(":", "")}`;
  const shadowId = `pet-shadow-${useId().replaceAll(":", "")}`;
  const resolvedEmotion = emotion ?? moodEmotion[mood];
  const scale = Math.max(75, Math.min(125, scalePercent)) / 100;
  const legacyFrame = petAtlasFrameForAction(action);
  const atlasAnimation = petAtlasAnimationForAction(action);
  // Keep the diagnostic step on the DOM node without re-rendering the whole
  // pet (and every speech bubble) on every animation beat. React state here
  // made the canvas compete with the compositor and amplified visible jumps.
  const handleAtlasStep = useCallback((step: number) => {
    rootRef.current?.setAttribute("data-pet-atlas-step", String(step));
  }, []);
  useEffect(() => {
    rootRef.current?.setAttribute("data-pet-atlas-step", "0");
  }, [action]);

  const animationFrameIndex = atlasAnimation.frames[0] ?? legacyFrame.index;
  const atlasFrame = petAtlasFrameFromIndex(
    animationFrameIndex,
    atlasAnimation.columns,
    atlasAnimation.rows,
  );
  const atlasUrl = petAtlasUrlForSheet(atlasAnimation.sheet);
  const [atlasReady, setAtlasReady] = useState(
    () => visualStyle !== "atlas" || petAtlasImageCache.has(atlasUrl),
  );
  useEffect(() => {
    setAtlasReady(visualStyle !== "atlas" || petAtlasImageCache.has(atlasUrl));
  }, [atlasUrl, visualStyle]);
  const handleAtlasReady = useCallback((ready: boolean) => {
    setAtlasReady(ready);
  }, []);
  const atlasCellWidth = 100 / atlasAnimation.columns;
  const atlasCellHeight = 100 / atlasAnimation.rows;

  const updateGaze = (event: PointerEvent<HTMLSpanElement>) => {
    if (!interactive || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const x = clampGaze(((event.clientX - rect.left) / rect.width - 0.5) * 2);
    const y = clampGaze(((event.clientY - rect.top) / rect.height - 0.5) * 2);
    rootRef.current.style.setProperty("--pet-gaze-x", String(x));
    rootRef.current.style.setProperty("--pet-gaze-y", String(y));
  };
  const resetGaze = () => {
    rootRef.current?.style.setProperty("--pet-gaze-x", "0");
    rootRef.current?.style.setProperty("--pet-gaze-y", "0");
  };

  return (
    <span
      ref={rootRef}
      className={`pet-character pet-visual-${visualStyle} pet-mood-${mood} pet-emotion-${resolvedEmotion} pet-action-${action} pet-palette-${palette} pet-outfit-${outfit} pet-personality-${personality} ${season ? `pet-season-${season}` : ""} ${weatherEffect ? `pet-weather-${weatherEffect}` : ""} ${compact ? "is-compact" : ""} ${interactive ? "is-interactive" : ""}`}
      data-pet-action={action}
      data-pet-emotion={resolvedEmotion}
      data-pet-palette={palette}
      data-pet-outfit={outfit}
      data-pet-weather-effect={weatherEffect ?? "clear"}
      data-pet-personality={personality}
      data-pet-visual-style={visualStyle}
      data-pet-atlas-sheet={atlasAnimation.sheet}
      data-pet-atlas-frame={legacyFrame.name}
      data-pet-atlas-animation={atlasAnimation.name}
      data-pet-atlas-step="0"
      data-pet-atlas-columns={atlasAnimation.columns}
      data-pet-atlas-rows={atlasAnimation.rows}
      data-pet-atlas-ready={visualStyle !== "atlas" || atlasReady ? "true" : "false"}
      role="img"
      aria-label={`${name}，${personalityLabels[personality]}，${moodLabels[mood]}，${emotionLabels[resolvedEmotion]}，${petActionLabels[action]}`}
      style={{
        "--pet-scale": scale,
        "--pet-atlas-column": atlasFrame.column,
        "--pet-atlas-row": atlasFrame.row,
        "--pet-atlas-image-width": `${atlasAnimation.columns * 100}%`,
        "--pet-atlas-image-height": `${atlasAnimation.rows * 100}%`,
        "--pet-atlas-offset-x": `${-(atlasFrame.column * atlasCellWidth)}%`,
        "--pet-atlas-offset-y": `${-(atlasFrame.row * atlasCellHeight)}%`,
      } as CSSProperties}
      onPointerMove={updateGaze}
      onPointerLeave={resetGaze}
    >
      <span className="pet-atlas-sprite" aria-hidden="true">
        {visualStyle === "atlas" && (
          <PetAtlasCanvas
            src={atlasUrl}
            animation={atlasAnimation}
            onStep={handleAtlasStep}
            onReady={handleAtlasReady}
          />
        )}
      </span>
      <svg viewBox="0 0 120 116" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="22" y1="12" x2="92" y2="101">
            <stop offset="0" stopColor="var(--pet-body-light)" />
            <stop offset="0.56" stopColor="var(--pet-body-mid)" />
            <stop offset="1" stopColor="var(--pet-body-dark)" />
          </linearGradient>
          <linearGradient id={bellyGradientId} x1="40" y1="44" x2="72" y2="91">
            <stop offset="0" stopColor="var(--pet-belly-light)" />
            <stop offset="1" stopColor="var(--pet-belly-dark)" />
          </linearGradient>
          <filter id={shadowId} x="-35%" y="-35%" width="180%" height="200%">
            <feDropShadow dx="0" dy="7" stdDeviation="5.5" floodColor="var(--pet-shadow-color)" floodOpacity="0.28" />
          </filter>
        </defs>

        <ellipse className="pet-ground" cx="57" cy="105" rx="31" ry="5.5" />
        <g className="pet-jump-rope pet-jump-rope-back">
          <path d="M20 78C12 24 31 8 58 8s47 16 44 70" />
        </g>
        <g className="pet-rig" filter={`url(#${shadowId})`}>
          <g className="pet-tail-rig">
            <path className="pet-tail" d="M86 76c17-6 23 3 17 13-3 5-9 6-14 4 7-2 9-8 4-10-3-2-7 0-9 2Z" />
          </g>

          <g className="pet-leg pet-leg-left">
            <ellipse className="pet-foot" cx="42" cy="96" rx="10" ry="6" />
          </g>
          <g className="pet-leg pet-leg-right">
            <ellipse className="pet-foot" cx="74" cy="96" rx="10" ry="6" />
          </g>

          <g className="pet-body-rig">
            <path
              className="pet-body"
              fill={`url(#${gradientId})`}
              d="M27 54c0-20 13-31 30-31s31 11 31 31v24c0 18-12 28-31 28S27 96 27 78Z"
            />
            <ellipse className="pet-belly" fill={`url(#${bellyGradientId})`} cx="57" cy="75" rx="22" ry="23" />
            <path className="pet-check" d="m47 76 7 7 14-16" />
          </g>

          <g className="pet-arm-rig pet-arm-left-rig">
            <path className="pet-arm pet-arm-left" d="M30 60c-10 2-13 10-9 18" />
            <circle className="pet-paw pet-paw-left" cx="21" cy="77" r="4.2" />
          </g>
          <g className="pet-arm-rig pet-arm-right-rig">
            <path className="pet-arm pet-arm-right" d="M84 60c10 2 13 10 9 18" />
            <circle className="pet-paw pet-paw-right" cx="93" cy="77" r="4.2" />
          </g>

          <g className="pet-head-rig">
            <g className="pet-ear-rig pet-ear-left-rig">
              <path className="pet-ear pet-ear-left" fill={`url(#${gradientId})`} d="M29 42 26 17 45 31Z" />
              <path className="pet-ear-inner" d="m31 34-1-10 9 7Z" />
            </g>
            <g className="pet-ear-rig pet-ear-right-rig">
              <path className="pet-ear pet-ear-right" fill={`url(#${gradientId})`} d="m85 42 3-25-19 14Z" />
              <path className="pet-ear-inner" d="m83 34 1-10-9 7Z" />
            </g>
            <ellipse className="pet-head" fill={`url(#${gradientId})`} cx="57" cy="49" rx="31" ry="27" />
            <g className="pet-brows">
              <path className="pet-brow pet-brow-left" d="M40 39c3-2 7-2 10 0" />
              <path className="pet-brow pet-brow-right" d="M64 39c3-2 7-2 10 0" />
            </g>
            <g className="pet-face">
              <g className="pet-eye-open pet-eye-open-left">
                <ellipse className="pet-eye-white" cx="45" cy="49" rx="6.3" ry="8" />
                <circle className="pet-pupil pet-pupil-left" cx="46" cy="50" r="3.7" />
                <circle className="pet-eye-shine" cx="47.2" cy="47.8" r="1.3" />
              </g>
              <g className="pet-eye-open pet-eye-open-right">
                <ellipse className="pet-eye-white" cx="69" cy="49" rx="6.3" ry="8" />
                <circle className="pet-pupil pet-pupil-right" cx="70" cy="50" r="3.7" />
                <circle className="pet-eye-shine" cx="71.2" cy="47.8" r="1.3" />
              </g>
              <g className="pet-closed-eyes">
                <path d="M39 49c3 4 9 4 12 0" />
                <path d="M63 49c3 4 9 4 12 0" />
              </g>
              <circle className="pet-cheek" cx="36" cy="60" r="4.2" />
              <circle className="pet-cheek" cx="78" cy="60" r="4.2" />
              <g className="pet-mouths">
                <path className="pet-mouth pet-mouth-neutral" d="M52 60c3 3 7 3 10 0" />
                <path className="pet-mouth pet-mouth-smile" d="M49 58c4 8 12 8 16 0" />
                <path className="pet-mouth pet-mouth-open" d="M52 58c0 8 10 8 10 0-2-3-8-3-10 0Z" />
                <ellipse className="pet-mouth pet-mouth-o" cx="57" cy="61" rx="4" ry="5" />
                <path className="pet-mouth pet-mouth-worry" d="M51 64c3-4 9-4 12 0" />
                <path className="pet-mouth pet-mouth-focus" d="M53 62h8" />
                <path className="pet-mouth pet-mouth-sleep" d="M52 62c3-2 7-2 10 0" />
              </g>
            </g>
          </g>

          <g className="pet-outfit pet-outfit-scarf-rig">
            <path d="M35 66c14 6 29 6 44 0l-2 9c-13 5-27 5-40 0Z" />
            <path d="M72 72c3 8 4 16 1 23l-8-7 2-15Z" />
          </g>
          <g className="pet-outfit pet-outfit-explorer-rig">
            <path d="M33 30c9-10 39-10 48 0l-5 5H38Z" />
            <path d="M43 24c5-7 23-7 28 0Z" />
            <path d="M82 77c9 2 13 8 11 16l-13-2Z" />
          </g>
          <g className="pet-outfit pet-outfit-starlight-rig">
            <path d="M34 70c8 3 38 3 46 0l8 27-31 7-31-7Z" />
            <path d="m88 34 2 5 5 .4-4 3 1.3 5-4.3-2.8-4.3 2.8 1.3-5-4-3 5-.4Z" />
          </g>

          <g className="pet-season-prop pet-season-prop-spring">
            <path d="m87 19 5-6 5 6-5 6Z" />
            <path d="M91 19c-5 5-8 11-8 18" />
          </g>
          <g className="pet-season-prop pet-season-prop-summer">
            <path d="M28 27c17-8 41-8 58 0l-3 5H31Z" />
            <path d="M47 23c7-4 15-4 22 0" />
          </g>
          <g className="pet-season-prop pet-season-prop-autumn">
            <path d="m92 21 7-3-2 8-6 3Z" />
            <path d="M94 25c-5 8-7 14-7 22" />
          </g>
          <g className="pet-season-prop pet-season-prop-winter">
            <path d="M35 65c13 5 29 5 44 0l-2 8c-13 5-27 5-40 0Z" />
            <path className="pet-season-line" d="M45 68v6M57 69v6M69 68v6" />
          </g>

          <g className="pet-weather-prop pet-weather-prop-rain">
            <path d="M82 29c4-9 17-14 27-7 4 2 7 5 8 9-4-2-7-2-10 1-3-3-7-3-10 0-3-3-7-3-10-1-2-1-3-1-5-2Z" />
            <path className="pet-weather-line" d="M97 31v15c0 5-3 7-6 5" />
            <path className="pet-weather-drop" d="m82 48-2 5M104 48l-2 5" />
          </g>
          <g className="pet-weather-prop pet-weather-prop-snow">
            <path className="pet-weather-line" d="M98 16v16M90 24h16M92 18l12 12M104 18 92 30" />
            <circle className="pet-weather-dot" cx="84" cy="22" r="2" />
            <circle className="pet-weather-dot" cx="108" cy="38" r="2" />
          </g>
          <g className="pet-weather-prop pet-weather-prop-storm">
            <path d="M82 28c3-8 16-12 25-6 4 2 6 5 7 9-4-2-7-2-10 1-3-3-7-3-10 0-4-3-8-3-12-1Z" />
            <path className="pet-weather-lightning" d="m99 32-7 12h6l-4 10 11-16h-6Z" />
          </g>

          <g className="pet-prop pet-prop-book">
            <path d="M34 68c8-3 16-1 23 5v19c-7-6-15-8-23-4Z" />
            <path d="M80 68c-8-3-16-1-23 5v19c7-6 15-8 23-4Z" />
            <path className="pet-prop-line" d="M57 73v19" />
          </g>
          <g className="pet-prop pet-prop-cup">
            <path d="M66 73h17v16c0 5-4 8-8.5 8S66 94 66 89Z" />
            <path className="pet-prop-line" d="M83 78h3c6 0 6 10 0 10h-3M70 69c-3-4 3-5 0-9M77 69c-3-4 3-5 0-9" />
          </g>
          <g className="pet-prop pet-prop-ball">
            <circle cx="86" cy="91" r="11" />
            <path className="pet-prop-line" d="M77 86c6 1 11 6 13 13M82 81c1 7 6 12 13 14" />
          </g>
          <g className="pet-prop pet-prop-juggle">
            <circle cx="35" cy="48" r="4.2" />
            <circle cx="57" cy="32" r="4.2" />
            <circle cx="79" cy="48" r="4.2" />
            <path className="pet-prop-line" d="M35 48c4-16 18-22 22-16M57 32c5 0 18 7 22 16" />
          </g>
          <g className="pet-prop pet-prop-snack">
            <circle cx="80" cy="78" r="9" />
            <circle className="pet-snack-chip" cx="76" cy="75" r="1.3" />
            <circle className="pet-snack-chip" cx="83" cy="73" r="1.2" />
            <circle className="pet-snack-chip" cx="82" cy="81" r="1.4" />
            <circle className="pet-snack-chip" cx="76" cy="82" r="1.1" />
          </g>
          <g className="pet-prop pet-prop-headphones">
            <path className="pet-prop-line" d="M33 48c0-17 9-26 24-26s24 9 24 26" />
            <rect x="28" y="43" width="9" height="20" rx="4" />
            <rect x="77" y="43" width="9" height="20" rx="4" />
          </g>
          <g className="pet-prop pet-prop-task-card">
            <rect x="35" y="66" width="45" height="29" rx="6" />
            <path className="pet-prop-line" d="m43 80 5 5 8-11M61 77h11M61 84h9" />
          </g>
          <g className="pet-prop pet-prop-keyboard">
            <rect x="29" y="86" width="56" height="13" rx="4" />
            <path className="pet-prop-line" d="M35 90h4M42 90h4M49 90h4M56 90h4M63 90h4M70 90h4M38 95h30" />
          </g>
          <g className="pet-prop pet-prop-magnifier">
            <circle cx="72" cy="72" r="10" />
            <path className="pet-prop-line" d="m79 79 10 11" />
          </g>
          <g className="pet-prop pet-prop-sync-box">
            <path d="m38 71 19-9 19 9-19 10Z" />
            <path d="m38 71 19 10v15L38 86ZM76 71 57 81v15l19-10Z" />
            <path className="pet-prop-line" d="M48 67 67 77" />
          </g>
        </g>

        <g className="pet-jump-rope pet-jump-rope-front">
          <path d="M20 78c8 32 69 32 82 0" />
        </g>
        <g className="pet-jump-rope pet-jump-rope-handles">
          <path d="m16 72 8 12M98 84l8-12" />
        </g>

        <g className="pet-interaction-effect pet-pat-hand">
          <path className="pet-user-hand" d="M38 6c0-3 5-3 5 0v7-4c0-4 6-4 6 0v4-5c0-4 6-4 6 0v6-3c0-4 6-4 6 0v10c0 8-5 13-13 13-7 0-11-4-14-10l-4-8c-2-4 4-7 7-3l1 2Z" />
          <path className="pet-contact-line" d="M41 38l-3 5M50 39v6M59 38l3 5" />
        </g>
        <g className="pet-interaction-effect pet-poke-finger">
          <path className="pet-user-hand" d="M2 69h33l8-7c4-3 8 1 5 5l-3 3h9c5 0 8 3 8 7s-3 7-8 7H2Z" />
          <path className="pet-hand-cuff" d="M2 69h11v15H2Z" />
          <circle className="pet-contact-dot" cx="60" cy="77" r="3.2" />
        </g>
        <g className="pet-interaction-effect pet-poke-ripple">
          <circle cx="57" cy="77" r="7" />
          <circle cx="57" cy="77" r="13" />
        </g>
        <g className="pet-interaction-effect pet-tickle-feather">
          <path className="pet-feather-stem" d="M106 58c-9 6-16 14-20 25" />
          <path className="pet-feather-fill" d="M105 58c-10-1-18 4-19 12 7 2 15-2 19-12ZM96 67c7 0 11 4 10 9-6 2-11-2-10-9Z" />
        </g>
        <g className="pet-interaction-effect pet-high-five-hand">
          <path className="pet-user-hand" d="M112 32c4-2 7 3 4 6l-5 4 5-1c5-1 7 5 2 7l-6 2 5 1c5 1 4 7-1 7h-13c-8 0-13-5-13-12 0-6 3-11 8-15l7-6c4-3 8 2 5 6l-3 4Z" />
          <path className="pet-contact-line" d="M91 34l-4-5M88 41h-7M94 28l-1-7" />
        </g>

        <g className="pet-action-mark pet-sleep-mark">
          <path d="M84 20h11L84 32h12M76 12h8l-8 9h9" />
        </g>
        <g className="pet-action-mark pet-heart-mark">
          <path d="M91 35c-11-7-16-13-16-19 0-7 9-9 16-2 7-7 16-5 16 2 0 6-5 12-16 19Z" />
        </g>
        <g className="pet-action-mark pet-think-mark">
          <circle cx="84" cy="30" r="3" /><circle cx="94" cy="23" r="4" /><circle cx="104" cy="15" r="5" />
        </g>
        <g className="pet-action-mark pet-approval-mark">
          <path d="M93 12 104 16v9c0 8-4 13-11 17-7-4-11-9-11-17v-9Z" />
          <path className="pet-action-line" d="m88 27 3 3 7-9" />
        </g>
        <g className="pet-action-mark pet-music-mark">
          <path d="M91 16v14c0 5-8 6-8 1 0-4 5-5 8-3M91 19l10-3v11c0 5-8 6-8 1 0-4 5-5 8-3" />
        </g>
        <g className="pet-action-mark pet-confetti-mark">
          <path d="m18 22 4 6M13 36l7 1M96 52l8-3M96 40l5-6" />
          <circle cx="17" cy="17" r="2" /><circle cx="105" cy="30" r="2" />
        </g>
        <g className="pet-action-mark pet-error-mark">
          <circle cx="95" cy="23" r="12" />
          <path d="m90 18 10 10M100 18 90 28" />
        </g>
      </svg>
    </span>
  );
}
