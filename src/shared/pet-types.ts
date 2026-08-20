import type { TaskId } from "./models";

export type FocusTimerMode = "pomodoro" | "count-up";
export type FocusPhase = "focus" | "short-break" | "long-break";
export type FocusRunStatus = "running" | "paused" | "awaiting-completion";

export interface FocusPreset {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  cycles: number;
}

export interface FocusInterruption {
  at: string;
  reason?: string;
}

export interface FocusSession {
  id: string;
  mode: FocusTimerMode;
  phase: FocusPhase;
  status: FocusRunStatus;
  taskId?: TaskId;
  taskTitle?: string;
  preset: FocusPreset;
  cycle: number;
  startedAt?: string;
  accumulatedSeconds: number;
  targetSeconds?: number;
  autoStartBreak: boolean;
  autoStartNextRound: boolean;
  interruptions: FocusInterruption[];
  createdAt: string;
  updatedAt: string;
}

export interface FocusSessionView extends FocusSession {
  elapsedSeconds: number;
  remainingSeconds?: number;
  expectedEndAt?: string;
}

export interface FocusHistoryRecord {
  id: string;
  sessionId: string;
  phase: FocusPhase;
  cycle: number;
  taskId?: TaskId;
  taskTitle?: string;
  plannedSeconds?: number;
  actualSeconds: number;
  outcome: "completed" | "abandoned";
  completedAt: string;
}

export interface StartFocusRequest {
  mode: FocusTimerMode;
  taskId?: TaskId;
  taskTitle?: string;
  preset?: FocusPreset;
  autoStartBreak?: boolean;
  autoStartNextRound?: boolean;
}

export type PetAttribute =
  | "knowledge"
  | "energy"
  | "creativity"
  | "organization"
  | "courage";

export interface PetProfile {
  id: string;
  name: string;
  species: "task-sprite";
  stage: "seed" | "companion" | "partner" | "guardian";
  level: number;
  experience: number;
  intimacy: number;
  attributes: Record<PetAttribute, number>;
  equippedOutfit?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PetReward {
  id: string;
  idempotencyKey: string;
  source:
    | "task"
    | "focus"
    | "planning"
    | "review"
    | "rest"
    | "interaction"
    | "adventure"
    | "game"
    | "customization";
  sourceId: string;
  experience: number;
  intimacy: number;
  attribute?: PetAttribute;
  attributePoints?: number;
  itemId?: string;
  grantedAt: string;
}

export interface PetInventoryItem {
  id: string;
  quantity: number;
  unlockedAt: string;
}

export type PetPalette = "lavender" | "mint" | "sunset" | "midnight";
export type PetOutfit = "none" | "scarf" | "explorer" | "starlight";
export type PetRoomTheme = "cloud-room" | "forest-nook" | "night-library";

export interface PetAppearance {
  palette: PetPalette;
  outfit: PetOutfit;
  roomTheme: PetRoomTheme;
  decorations: string[];
}

export interface PetCustomizationPatch {
  palette?: PetPalette;
  outfit?: PetOutfit;
  roomTheme?: PetRoomTheme;
  decorations?: string[];
}

export interface PetAdventureChoice {
  id: string;
  label: string;
}

export interface PetAdventure {
  id: string;
  localDate: string;
  title: string;
  prompt: string;
  choices: PetAdventureChoice[];
  selectedChoiceId?: string;
  outcome?: string;
  rewardId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface PetMiniGameRecord {
  id: string;
  game: "breathing" | "star-catch" | "jump-rope" | "stretch-mirror";
  score: number;
  durationSeconds: number;
  completedAt: string;
}

export interface PetDiaryEntry {
  id: string;
  localDate: string;
  title: string;
  content: string;
  /**
   * Local links back to the task records that shaped this entry. The links
   * are intentionally private to Todo Agent: they are navigation metadata,
   * never provider-owned fields written to Feishu.
   */
  taskIds?: TaskId[];
  generation: "local-template" | "model" | "user";
  completedTaskCount: number;
  focusRounds: number;
  focusSeconds: number;
  rewardIds: string[];
  weatherSummary?: string;
  userEdited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PetMemoryEntry {
  id: string;
  kind: "preference" | "relationship" | "shared-experience";
  content: string;
  enabled: boolean;
  approvedByUser: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveMessageRecord {
  id: string;
  kind:
    | "companion"
    | "planning"
    | "deadline"
    | "wellbeing"
    | "weather"
    | "sync"
    | "morning"
    | "evening";
  reason: string;
  shownAt: string;
  dismissed?: boolean;
}

export interface PetState {
  schemaVersion: 1;
  revision: number;
  profile: PetProfile;
  focus?: FocusSession;
  focusHistory: FocusHistoryRecord[];
  rewards: PetReward[];
  inventory: PetInventoryItem[];
  appearance: PetAppearance;
  adventures: PetAdventure[];
  miniGames: PetMiniGameRecord[];
  diary: PetDiaryEntry[];
  memories: PetMemoryEntry[];
  proactiveMessages: ProactiveMessageRecord[];
}

export interface PetSnapshot extends Omit<PetState, "focus"> {
  focus?: FocusSessionView;
}

export interface WeatherSnapshot {
  city: string;
  latitude: number;
  longitude: number;
  conditionCode: number;
  conditionLabel: string;
  temperatureC: number;
  apparentTemperatureC?: number;
  lowC?: number;
  highC?: number;
  precipitationProbability?: number;
  severe: boolean;
  fetchedAt: string;
  expiresAt: string;
  stale: boolean;
}

export interface PetEvent {
  type:
    | "state-changed"
    | "focus-phase-completed"
    | "focus-phase-started"
    | "reward-granted"
    | "weather-updated"
    | "adventure-completed"
    | "mini-game-completed"
    | "customization-changed";
  at: string;
  focus?: FocusSessionView;
  reward?: PetReward;
  weather?: WeatherSnapshot;
}

export const defaultFocusPreset: FocusPreset = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  cycles: 4,
};
