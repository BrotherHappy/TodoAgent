import type { PetAction } from "./pet-behavior";
import atlasUrl from "../assets/todo-pet-action-atlas-v2.png";
import motionAtlasPage00 from "../assets/todo-pet-motion-atlas-v25-00.png";
import motionAtlasPage01 from "../assets/todo-pet-motion-atlas-v25-01.png";
import motionAtlasPage02 from "../assets/todo-pet-motion-atlas-v25-02.png";
import motionAtlasPage03 from "../assets/todo-pet-motion-atlas-v25-03.png";
import motionAtlasPage04 from "../assets/todo-pet-motion-atlas-v25-04.png";
import motionAtlasPage05 from "../assets/todo-pet-motion-atlas-v25-05.png";
import motionAtlasPage06 from "../assets/todo-pet-motion-atlas-v25-06.png";
import motionAtlasPage07 from "../assets/todo-pet-motion-atlas-v25-07.png";
import motionAtlasPage08 from "../assets/todo-pet-motion-atlas-v25-08.png";
import motionAtlasPage09 from "../assets/todo-pet-motion-atlas-v25-09.png";
import interactionAtlasPage00 from "../assets/todo-pet-interaction-atlas-v23-00.png";
import interactionAtlasPage01 from "../assets/todo-pet-interaction-atlas-v23-01.png";
import interactionAtlasPage02 from "../assets/todo-pet-interaction-atlas-v23-02.png";
import interactionAtlasPage03 from "../assets/todo-pet-interaction-atlas-v23-03.png";
import interactionAtlasPage04 from "../assets/todo-pet-interaction-atlas-v23-04.png";
import interactionAtlasPage05 from "../assets/todo-pet-interaction-atlas-v23-05.png";
import interactionAtlasPage06 from "../assets/todo-pet-interaction-atlas-v23-06.png";
import interactionAtlasPage07 from "../assets/todo-pet-interaction-atlas-v23-07.png";
import interactionAtlasPage08 from "../assets/todo-pet-interaction-atlas-v23-08.png";
import interactionAtlasPage09 from "../assets/todo-pet-interaction-atlas-v23-09.png";
import interactionAtlasPage10 from "../assets/todo-pet-interaction-atlas-v23-10.png";
import interactionAtlasPage11 from "../assets/todo-pet-interaction-atlas-v23-11.png";
import interactionAtlasPage12 from "../assets/todo-pet-interaction-atlas-v23-12.png";

/**
 * The generated atlases are deterministic visual layers. The legacy sheet
 * remains a 4×4 grid for one-off fallback poses. The high-density motion and
 * interaction sheets keep their 577/769 logical frames, but are split into
 * square 16×16-cell GPU pages. The previous v21/v19 files were only 2,048px
 * wide; their 18,944/25,088px height still exceeded WebKit's common
 * 16,384px texture limit and could make the compositor tear while sampling a
 * new cell. Every v25/v23 page is 2,048×2,048px (the final page is padded
 * transparent), so no hidden driver tiling is needed. Cells are authored at
 * 128px and retain the authored high-density timing from the v25/v23 source
 * strips. Runtime pages use anchor-stabilised signed-distance in-betweens only
 * for the checked compact-pose rows; large pose changes and detached props
 * use one complete source pose along an anchor path. Each dense cell contains
 * one complete pet, never a coloured edge or double silhouette from a raster
 * cross-fade.
 */
export const TODO_PET_ATLAS_URL = atlasUrl;
export const TODO_PET_MOTION_ATLAS_URLS = [
  motionAtlasPage00,
  motionAtlasPage01,
  motionAtlasPage02,
  motionAtlasPage03,
  motionAtlasPage04,
  motionAtlasPage05,
  motionAtlasPage06,
  motionAtlasPage07,
  motionAtlasPage08,
  motionAtlasPage09,
] as const;
export const TODO_PET_INTERACTION_ATLAS_URLS = [
  interactionAtlasPage00,
  interactionAtlasPage01,
  interactionAtlasPage02,
  interactionAtlasPage03,
  interactionAtlasPage04,
  interactionAtlasPage05,
  interactionAtlasPage06,
  interactionAtlasPage07,
  interactionAtlasPage08,
  interactionAtlasPage09,
  interactionAtlasPage10,
  interactionAtlasPage11,
  interactionAtlasPage12,
] as const;
/** Backwards-compatible first-page aliases for diagnostics and integrations. */
export const TODO_PET_MOTION_ATLAS_URL = TODO_PET_MOTION_ATLAS_URLS[0];
export const TODO_PET_INTERACTION_ATLAS_URL = TODO_PET_INTERACTION_ATLAS_URLS[0];
export const TODO_PET_ATLAS_COLUMNS = 4;
export const TODO_PET_ATLAS_ROWS = 4;
export const TODO_PET_MOTION_SOURCE_COLUMNS = 577;
export const TODO_PET_MOTION_SOURCE_ROWS = 4;
export const TODO_PET_INTERACTION_SOURCE_COLUMNS = 769;
export const TODO_PET_INTERACTION_SOURCE_ROWS = 4;
export const TODO_PET_ATLAS_PAGE_COLUMNS = 16;
/** Runtime page geometry. Each image stays safely below GPU texture limits. */
export const TODO_PET_ATLAS_PAGE_ROWS = 16;
export const TODO_PET_ATLAS_PAGE_SIZE = TODO_PET_ATLAS_PAGE_COLUMNS * TODO_PET_ATLAS_PAGE_ROWS;
export const TODO_PET_MOTION_PAGE_COUNT = Math.ceil(
  TODO_PET_MOTION_SOURCE_COLUMNS * TODO_PET_MOTION_SOURCE_ROWS / TODO_PET_ATLAS_PAGE_SIZE,
);
export const TODO_PET_INTERACTION_PAGE_COUNT = Math.ceil(
  TODO_PET_INTERACTION_SOURCE_COLUMNS * TODO_PET_INTERACTION_SOURCE_ROWS / TODO_PET_ATLAS_PAGE_SIZE,
);
/** Runtime columns/rows inside each bounded page image. */
export const TODO_PET_MOTION_COLUMNS = TODO_PET_ATLAS_PAGE_COLUMNS;
export const TODO_PET_MOTION_ROWS = TODO_PET_ATLAS_PAGE_ROWS;
export const TODO_PET_INTERACTION_COLUMNS = TODO_PET_ATLAS_PAGE_COLUMNS;
export const TODO_PET_INTERACTION_ROWS = TODO_PET_ATLAS_PAGE_ROWS;
/** Number of offline in-between cells inserted between authored poses. */
export const TODO_PET_INTERPOLATION_STEPS = 63;

export type PetAtlasSheet = "legacy" | "motion" | "interaction";

export interface PetAtlasAnimation {
  /** Which generated sheet contains the frames. */
  sheet: PetAtlasSheet;
  /** Frame indices in playback order. */
  frames: readonly number[];
  /** Number of columns in the selected sheet. */
  columns: number;
  /** Number of rows in the selected sheet. */
  rows: number;
  /** Delay between adjacent frames. */
  frameDurationMs: number;
  /** Whether the sequence should loop while the state is active. */
  loop: boolean;
  /** Stable label used for diagnostics and accessibility tests. */
  name: string;
}

export interface PetAtlasFrame {
  index: number;
  column: number;
  row: number;
  name: string;
}

const frameNames = [
  "idle",
  "blink",
  "curious",
  "wave",
  "think",
  "type",
  "focus",
  "build",
  "juggle",
  "wait",
  "notify",
  "complete",
  "error",
  "sleep",
  "wake",
  "carry",
] as const;

const actionToFrame: Record<PetAction, number> = {
  idle: 0,
  wave: 3,
  stretch: 14,
  yawn: 13,
  nap: 13,
  read: 0,
  play: 2,
  drink: 0,
  "look-left": 2,
  "look-right": 2,
  "head-tilt": 2,
  "tail-wag": 3,
  "ear-twitch": 2,
  sit: 0,
  dance: 3,
  hum: 0,
  inspect: 4,
  tidy: 7,
  type: 5,
  float: 3,
  peek: 2,
  pet: 0,
  poke: 2,
  tickle: 2,
  "high-five": 3,
  snack: 0,
  "jump-rope-ready": 14,
  "jump-rope": 14,
  drag: 15,
  celebrate: 11,
  "task-carry": 15,
  "task-drop": 15,
  "task-plan": 7,
  "task-complete": 11,
  "task-clear": 11,
  focus: 6,
  "focus-paused": 9,
  break: 0,
  sync: 15,
  "sync-success": 11,
  "sync-error": 12,
  alert: 10,
  think: 4,
  search: 4,
  work: 5,
  juggle: 8,
  approve: 10,
  "agent-error": 12,
};

const singleFrameAnimation = (
  action: PetAction,
): PetAtlasAnimation => ({
  sheet: "legacy",
  frames: [actionToFrame[action] ?? 0],
  columns: TODO_PET_ATLAS_COLUMNS,
  rows: TODO_PET_ATLAS_ROWS,
  frameDurationMs: 260,
  loop: false,
  name: `legacy-${action}`,
});

/**
 * The v25/v23 sheets are packed from the high-frame source strips and include
 * offline in-between cells. Keeping the mapping in data (rather than CSS
 * selectors) means every PetCharacter gets the same timing and a state change
 * always restarts at the entrance frame.
 */
/**
 * Convert a logical source-sheet (row, column) into the flattened index of
 * the vertically paged runtime image. The page is stacked by source rows, so
 * page 0 rows come first, followed by page 1 rows, and so on.
 */
const pagedFrameIndex = (
  column: number,
  row: number,
  sourceRows: number,
): number => {
  const page = Math.floor(column / TODO_PET_ATLAS_PAGE_COLUMNS);
  const localColumn = column % TODO_PET_ATLAS_PAGE_COLUMNS;
  return (page * sourceRows + row) * TODO_PET_ATLAS_PAGE_COLUMNS + localColumn;
};

const motionFrame = (row: number, column: number): number => pagedFrameIndex(
  column,
  row,
  TODO_PET_MOTION_SOURCE_ROWS,
);

const interactionFrame = (row: number, column: number): number => pagedFrameIndex(
  column,
  row,
  TODO_PET_INTERACTION_SOURCE_ROWS,
);

/**
 * Return a coherent slice of an interpolated source row. The generated strips
 * contain a few authored poses that are useful as standalone states (for
 * example, the celebration source also contains a seated rest pose). Playing
 * the entire row would make those unrelated poses appear as a sudden jump.
 * Selecting source transitions keeps each loop semantically consistent while
 * still using every in-between cell inside that transition.
 */
const interpolatedRange = (
  frameFor: (row: number, column: number) => number,
  row: number,
  startSourceColumn: number,
  endSourceColumn: number,
): number[] => {
  const start = Math.max(0, Math.floor(startSourceColumn));
  const end = Math.max(start, Math.floor(endSourceColumn));
  const frames: number[] = [];
  for (let sourceColumn = start; sourceColumn < end; sourceColumn += 1) {
    const firstInterpolatedColumn = sourceColumn * (TODO_PET_INTERPOLATION_STEPS + 1);
    for (let offset = 0; offset <= TODO_PET_INTERPOLATION_STEPS; offset += 1) {
      frames.push(frameFor(row, firstInterpolatedColumn + offset));
    }
  }
  // The final authored pose is the last cell of the selected transition. It
  // is intentionally added once so the renderer's ping-pong loop reverses
  // from a real key pose instead of snapping to the next unrelated source.
  frames.push(frameFor(row, end * (TODO_PET_INTERPOLATION_STEPS + 1)));
  return frames;
};

const motionRange = (row: number, start: number, end: number): number[] => interpolatedRange(
  motionFrame,
  row,
  start,
  end,
);

const interactionRange = (row: number, start: number, end: number): number[] => interpolatedRange(
  interactionFrame,
  row,
  start,
  end,
);

const motion = (
  name: string,
  row: number,
  frameDurationMs = 145,
): PetAtlasAnimation => ({
  sheet: "motion",
  frames: Array.from(
    { length: TODO_PET_MOTION_SOURCE_COLUMNS },
    (_, column) => motionFrame(row, column),
  ),
  columns: TODO_PET_MOTION_COLUMNS,
  rows: TODO_PET_MOTION_ROWS,
  frameDurationMs,
  loop: true,
  name,
});

const interaction = (
  name: string,
  row: number,
  frameDurationMs = 150,
): PetAtlasAnimation => ({
  sheet: "interaction",
  frames: Array.from(
    { length: TODO_PET_INTERACTION_SOURCE_COLUMNS },
    (_, column) => interactionFrame(row, column),
  ),
  columns: TODO_PET_INTERACTION_COLUMNS,
  rows: TODO_PET_INTERACTION_ROWS,
  frameDurationMs,
  loop: true,
  name,
});

const sequence = (
  sheet: PetAtlasSheet,
  name: string,
  frames: readonly number[],
  frameDurationMs: number,
  loop = true,
): PetAtlasAnimation => ({
  sheet,
  frames,
  columns: sheet === "motion"
    ? TODO_PET_MOTION_COLUMNS
    : sheet === "interaction"
      ? TODO_PET_INTERACTION_COLUMNS
      : TODO_PET_ATLAS_COLUMNS,
  rows: sheet === "motion"
    ? TODO_PET_MOTION_ROWS
    : sheet === "interaction"
      ? TODO_PET_INTERACTION_ROWS
      : TODO_PET_ATLAS_ROWS,
  frameDurationMs,
  loop,
  name,
});

// The generated strips contain 63 dense in-betweens between each authored
// pose. Their duration must be calibrated to the *whole action*, not treated
// as if each cell were an authored keyframe. An 8ms cell made a wave/bounce
// last several seconds and looked like a low-FPS flipbook even though the
// sheet was dense. A 2ms cell keeps a normal 2–2.5s idle/wave cycle; the
// renderer advances the fractional playhead according to the display refresh
// and still presents one complete cell per commit.
const fastFrameMs = 2;
const idleLoop = motion("idle-breathe-blink", 0, fastFrameMs);
const waveLoop = motion("wave", 1, fastFrameMs);
const workLoop = motion("focus-work", 2, fastFrameMs);
// The fourth motion row includes a floating beat (3→5), a celebration beat
// (6→7), and a seated rest pose. Keep those as separate coherent loops.
const floatLoop = sequence("motion", "float", motionRange(3, 3, 5), fastFrameMs);
// The old 3→8 slice crossed sleep, sit and landing poses in one loop. That
// made celebration look like a hard-cut flipbook even with a dense atlas.
// The 6→7 slice is the authored arms-up → sparkle beat and keeps celebration
// semantically continuous; v25 also morphs the row contour instead of
// switching the complete body at the midpoint.
// Celebration is a short one-beat flourish, so keep its authored ~1s pace
// instead of using the longer idle/wave cadence.
const celebrateLoop = sequence("motion", "celebrate", motionRange(3, 6, 7), 8);
const restLoop = sequence("motion", "sit", motionRange(3, 8, 9), 34);
// Head-pat uses the approach → contact transition; ping-pong supplies the
// natural hand-away return without replaying unrelated idle key poses.
// Use the full hand approach → contact → release row so the hand never
// disappears halfway through the interaction.
// The source row contains a clean approach → contact beat in columns 0→6;
// later columns are separate "hand up / hand away" key poses. Playing the
// entire 13-column strip made the hand disappear and reappear mid-pat, which
// looked like a low-FPS tear even though the atlas had hundreds of cells.
const petLoop = sequence("interaction", "head-pat", interactionRange(0, 0, 6), fastFrameMs);
const ropeReadyLoop = sequence(
  "interaction",
  "jump-rope-ready",
  interactionRange(1, 0, 1),
  fastFrameMs,
  false,
);
// The crouched source pose is the explicit “ready” state. Starting the live
// loop at the airborne pose removes a 256ms hold on the crouch that read as a
// frozen frame after the first click; the ready state still shows that pose
// before the game begins. The live loop then covers the coherent airborne
// beats and completes in roughly one second.
const ropeLoop = sequence("interaction", "jump-rope", interactionRange(1, 4, 8), fastFrameMs);
const carryLoop = interaction("task-carry", 2, fastFrameMs);
const sleepLoop = sequence(
  "interaction",
  "sleep",
  interactionRange(3, 2, 7),
  34,
);

const actionAnimations: Partial<Record<PetAction, PetAtlasAnimation>> = {
  idle: idleLoop,
  wave: waveLoop,
  stretch: idleLoop,
  yawn: sleepLoop,
  nap: sleepLoop,
  read: workLoop,
  play: waveLoop,
  drink: idleLoop,
  "look-left": idleLoop,
  "look-right": idleLoop,
  "head-tilt": idleLoop,
  "tail-wag": waveLoop,
  "ear-twitch": idleLoop,
  sit: restLoop,
  dance: waveLoop,
  hum: waveLoop,
  inspect: workLoop,
  tidy: carryLoop,
  type: workLoop,
  float: floatLoop,
  peek: waveLoop,
  pet: petLoop,
  poke: petLoop,
  tickle: petLoop,
  "high-five": waveLoop,
  snack: petLoop,
  "jump-rope-ready": ropeReadyLoop,
  "jump-rope": ropeLoop,
  drag: carryLoop,
  celebrate: celebrateLoop,
  "task-carry": carryLoop,
  "task-drop": carryLoop,
  "task-plan": workLoop,
  "task-complete": celebrateLoop,
  "task-clear": celebrateLoop,
  focus: workLoop,
  "focus-paused": idleLoop,
  break: idleLoop,
  sync: carryLoop,
  "sync-success": celebrateLoop,
  "sync-error": singleFrameAnimation("sync-error"),
  alert: waveLoop,
  think: workLoop,
  search: workLoop,
  work: workLoop,
  juggle: waveLoop,
  approve: waveLoop,
  "agent-error": singleFrameAnimation("agent-error"),
};

export function petAtlasFrameForAction(action: PetAction): PetAtlasFrame {
  const index = actionToFrame[action] ?? 0;
  return {
    index,
    column: index % TODO_PET_ATLAS_COLUMNS,
    row: Math.floor(index / TODO_PET_ATLAS_COLUMNS),
    name: frameNames[index] ?? frameNames[0],
  };
}

export function petAtlasAnimationForAction(action: PetAction): PetAtlasAnimation {
  return actionAnimations[action] ?? singleFrameAnimation(action);
}

export function petAtlasUrlForSheet(sheet: PetAtlasSheet): string {
  if (sheet === "motion") return TODO_PET_MOTION_ATLAS_URLS[0];
  if (sheet === "interaction") return TODO_PET_INTERACTION_ATLAS_URLS[0];
  return TODO_PET_ATLAS_URL;
}

/** Return the bounded runtime pages for a generated sheet. */
export function petAtlasUrlsForSheet(sheet: PetAtlasSheet): readonly string[] {
  if (sheet === "motion") return TODO_PET_MOTION_ATLAS_URLS;
  if (sheet === "interaction") return TODO_PET_INTERACTION_ATLAS_URLS;
  return [TODO_PET_ATLAS_URL];
}

export function petAtlasFrameFromIndex(
  index: number,
  columns = TODO_PET_ATLAS_COLUMNS,
  rows = TODO_PET_ATLAS_ROWS,
): Pick<PetAtlasFrame, "index" | "column" | "row"> {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeRows = Math.max(1, Math.floor(rows));
  const safeIndex = Math.max(0, Math.min(safeColumns * safeRows - 1, Math.floor(index)));
  return {
    index: safeIndex,
    column: safeIndex % safeColumns,
    row: Math.floor(safeIndex / safeColumns),
  };
}
