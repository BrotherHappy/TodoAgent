import { taskThemeAction, type TaskThemeId } from "./task-theme-action-packs";

export type PetIdleAction =
  | "idle"
  | "wave"
  | "stretch"
  | "yawn"
  | "nap"
  | "read"
  | "play"
  | "drink"
  | "look-left"
  | "look-right"
  | "head-tilt"
  | "tail-wag"
  | "ear-twitch"
  | "sit"
  | "dance"
  | "hum"
  | "inspect"
  | "tidy"
  | "type"
  | "float"
  | "peek";

export type PetAction =
  | PetIdleAction
  | "pet"
  | "poke"
  | "tickle"
  | "high-five"
  | "snack"
  | "jump-rope-ready"
  | "jump-rope"
  | "drag"
  | "celebrate"
  | "task-carry"
  | "task-drop"
  | "task-plan"
  | "task-complete"
  | "task-clear"
  | "focus"
  | "focus-paused"
  | "break"
  | "sync"
  | "sync-success"
  | "sync-error"
  | "alert"
  | "think"
  | "search"
  | "work"
  | "approve"
  | "agent-error";

export type PetEmotion =
  | "calm"
  | "curious"
  | "happy"
  | "excited"
  | "focused"
  | "sleepy"
  | "concerned"
  | "proud";

export type PetInteractionKind =
  | "greet"
  | "pet"
  | "head-pat"
  | "belly-poke"
  | "high-five"
  | "tickle"
  | "treat"
  | "play"
  | "rest"
  | "morning"
  | "evening";

export type PetActionPack = "balanced" | "calm" | "playful" | "focused";

/**
 * A local-only declaration for a custom idle rhythm.  The action list stays
 * closed over the built-in animation vocabulary; weights only change how
 * often an already-approved action is selected.
 */
export interface PetIdleActionProfile {
  actions: readonly PetIdleAction[];
  /** Minimum pause before the next ambient action, in milliseconds. */
  cooldownMs?: number;
  /** Relative appearance frequency from 1 (occasional) to 5 (often). */
  weights?: Partial<Record<PetIdleAction, number>>;
}

export interface PetBehaviorContext {
  reducedMotion: boolean;
  focus?: {
    phase: "focus" | "short-break" | "long-break";
    status: "running" | "paused" | "awaiting-completion";
  };
  syncing: boolean;
  syncError?: boolean;
  syncJustCompleted?: boolean;
  agentSending: boolean;
  agentRunState: string;
  approvalPending: boolean;
  overdueCount: number;
  openTaskCount: number;
  taskDropActive?: boolean;
  /** Inferred companion posture for the task currently being shown. */
  taskTheme?: TaskThemeId;
}

export interface PetInteractionResponse {
  action: PetAction;
  emotion: PetEmotion;
  message: string;
  durationMs: number;
}

export interface PetActionDefinition {
  priority: number;
  durationMs: number;
  interruptible: boolean;
  emotion: PetEmotion;
}

export const idlePetActions: readonly PetIdleAction[] = [
  "idle",
  "wave",
  "stretch",
  "yawn",
  "nap",
  "read",
  "play",
  "drink",
  "look-left",
  "look-right",
  "head-tilt",
  "tail-wag",
  "ear-twitch",
  "sit",
  "dance",
  "hum",
  "inspect",
  "tidy",
  "float",
  "peek",
];

export const PET_IDLE_COOLDOWN_MIN_MS = 8_000;
export const PET_IDLE_COOLDOWN_MAX_MS = 60_000;

const boundedIdleCooldownMs = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return PET_IDLE_COOLDOWN_MIN_MS;
  return Math.min(
    PET_IDLE_COOLDOWN_MAX_MS,
    Math.max(PET_IDLE_COOLDOWN_MIN_MS, Math.floor(value as number)),
  );
};

const calmIdleActions: readonly PetIdleAction[] = [
  "idle",
  "stretch",
  "read",
  "drink",
  "look-left",
  "look-right",
  "head-tilt",
  "ear-twitch",
  "sit",
  "hum",
  "inspect",
  "tidy",
  "peek",
];

const playfulIdleActions: readonly PetIdleAction[] = [
  "wave",
  "play",
  "tail-wag",
  "dance",
  "float",
  "peek",
  "head-tilt",
  "ear-twitch",
  "stretch",
  "hum",
];

const focusedIdleActions: readonly PetIdleAction[] = [
  "idle",
  "read",
  "inspect",
  "tidy",
  "drink",
  "stretch",
  "sit",
  "look-left",
  "look-right",
];

const quietIdleActions: readonly PetIdleAction[] = [
  "idle",
  "yawn",
  "nap",
  "read",
  "drink",
  "stretch",
  "sit",
  "look-left",
  "look-right",
  "ear-twitch",
  "peek",
];

export const petActionLabels: Record<PetAction, string> = {
  idle: "安静呼吸",
  wave: "向你招手",
  stretch: "伸懒腰",
  yawn: "打哈欠",
  nap: "打个小盹",
  read: "安静看书",
  play: "追着毛线球玩",
  drink: "喝水休息",
  "look-left": "看看左边",
  "look-right": "看看右边",
  "head-tilt": "好奇地歪头",
  "tail-wag": "开心地摇尾巴",
  "ear-twitch": "耳朵动了一下",
  sit: "乖乖坐好",
  dance: "轻轻跳舞",
  hum: "哼着小曲",
  inspect: "拿放大镜观察",
  tidy: "整理任务卡",
  type: "轻轻敲键盘",
  float: "原地蹦一下",
  peek: "探头看看你",
  pet: "享受抚摸",
  poke: "肚子被轻轻戳了一下",
  tickle: "被逗得发痒",
  "high-five": "和你击掌",
  snack: "接过零食开心地吃掉",
  "jump-rope-ready": "握好绳子等你",
  "jump-rope": "和你一起跳绳",
  drag: "跟着你的鼠标移动",
  celebrate: "庆祝进展",
  "task-carry": "抱住任务卡",
  "task-drop": "接住任务卡",
  "task-plan": "重新安排任务",
  "task-complete": "完成任务并庆祝",
  "task-clear": "为清空任务感到骄傲",
  focus: "戴上耳机陪你专注",
  "focus-paused": "暂停下来等你",
  break: "陪你休息",
  sync: "搬运同步数据",
  "sync-success": "同步完成",
  "sync-error": "同步遇到问题",
  alert: "温和提醒",
  think: "认真思考",
  search: "查找资料",
  work: "执行任务",
  approve: "等待你的确认",
  "agent-error": "Agent 遇到问题",
};

const passiveDefinition = (
  emotion: PetEmotion,
  durationMs: number,
): PetActionDefinition => ({
  priority: 10,
  durationMs,
  interruptible: true,
  emotion,
});

export const petActionDefinitions: Record<PetAction, PetActionDefinition> = {
  idle: passiveDefinition("calm", 2_400),
  wave: passiveDefinition("happy", 2_300),
  stretch: passiveDefinition("calm", 2_900),
  yawn: passiveDefinition("sleepy", 3_000),
  nap: passiveDefinition("sleepy", 5_200),
  read: passiveDefinition("focused", 4_600),
  play: passiveDefinition("excited", 3_500),
  drink: passiveDefinition("calm", 3_600),
  "look-left": passiveDefinition("curious", 2_500),
  "look-right": passiveDefinition("curious", 2_500),
  "head-tilt": passiveDefinition("curious", 2_700),
  "tail-wag": passiveDefinition("happy", 2_800),
  "ear-twitch": passiveDefinition("curious", 2_000),
  sit: passiveDefinition("calm", 3_400),
  dance: passiveDefinition("excited", 3_800),
  hum: passiveDefinition("happy", 3_500),
  inspect: passiveDefinition("curious", 4_000),
  tidy: passiveDefinition("focused", 4_000),
  type: passiveDefinition("focused", 2_200),
  float: passiveDefinition("happy", 3_400),
  peek: passiveDefinition("curious", 2_800),
  pet: { priority: 35, durationMs: 2_900, interruptible: true, emotion: "happy" },
  poke: { priority: 35, durationMs: 2_100, interruptible: true, emotion: "curious" },
  tickle: { priority: 35, durationMs: 2_800, interruptible: true, emotion: "excited" },
  "high-five": { priority: 35, durationMs: 2_600, interruptible: true, emotion: "proud" },
  snack: { priority: 35, durationMs: 2_700, interruptible: true, emotion: "happy" },
  "jump-rope-ready": { priority: 48, durationMs: 0, interruptible: false, emotion: "focused" },
  "jump-rope": { priority: 50, durationMs: 820, interruptible: false, emotion: "excited" },
  // A direct drag should visibly lift the pet above focus/sync postures, but
  // it must never cover an approval or hard Agent failure state.
  drag: { priority: 96, durationMs: 1_200, interruptible: true, emotion: "excited" },
  celebrate: { priority: 60, durationMs: 3_500, interruptible: true, emotion: "proud" },
  "task-carry": { priority: 65, durationMs: 3_600, interruptible: true, emotion: "focused" },
  "task-drop": { priority: 68, durationMs: 3_200, interruptible: true, emotion: "excited" },
  "task-plan": { priority: 70, durationMs: 3_800, interruptible: true, emotion: "focused" },
  "task-complete": { priority: 72, durationMs: 3_800, interruptible: true, emotion: "proud" },
  "task-clear": { priority: 55, durationMs: 4_200, interruptible: true, emotion: "proud" },
  focus: { priority: 80, durationMs: 0, interruptible: false, emotion: "focused" },
  "focus-paused": { priority: 78, durationMs: 0, interruptible: false, emotion: "curious" },
  break: { priority: 80, durationMs: 0, interruptible: false, emotion: "calm" },
  sync: { priority: 86, durationMs: 0, interruptible: false, emotion: "focused" },
  "sync-success": { priority: 72, durationMs: 3_200, interruptible: true, emotion: "proud" },
  "sync-error": { priority: 92, durationMs: 0, interruptible: false, emotion: "concerned" },
  alert: { priority: 58, durationMs: 0, interruptible: true, emotion: "concerned" },
  think: { priority: 90, durationMs: 0, interruptible: false, emotion: "curious" },
  search: { priority: 92, durationMs: 0, interruptible: false, emotion: "focused" },
  work: { priority: 94, durationMs: 0, interruptible: false, emotion: "focused" },
  approve: { priority: 100, durationMs: 0, interruptible: false, emotion: "concerned" },
  "agent-error": { priority: 98, durationMs: 0, interruptible: false, emotion: "concerned" },
};

export function resolvePetAction(context: PetBehaviorContext): PetAction {
  if (context.reducedMotion) return "idle";
  if (context.approvalPending) return "approve";
  if (context.agentSending) {
    if (/失败|错误|中断|error|failed/u.test(context.agentRunState)) return "agent-error";
    if (/搜索|网页|资料|search|research/u.test(context.agentRunState)) return "search";
    if (/工具|执行|写入|命令|tool|running/u.test(context.agentRunState)) return "work";
    return "think";
  }
  if (context.syncError) return "sync-error";
  if (context.syncing) return "sync";
  if (context.syncJustCompleted) return "sync-success";
  if (context.taskDropActive) return "task-carry";
  if (context.focus?.status === "running") {
    return context.focus.phase === "focus" ? "focus" : "break";
  }
  if (context.focus?.status === "awaiting-completion") return "celebrate";
  if (context.focus?.status === "paused") return "focus-paused";
  const themedAction = taskThemeAction(context.taskTheme);
  if (themedAction) return themedAction;
  if (context.overdueCount > 0) return "alert";
  if (context.openTaskCount === 0) return "task-clear";
  return "idle";
}

export function emotionForPetAction(action: PetAction): PetEmotion {
  return petActionDefinitions[action].emotion;
}

export function pickIdlePetAction(
  seed: number,
  hour: number,
  pack: PetActionPack | readonly PetIdleAction[] | PetIdleActionProfile = "balanced",
): PetIdleAction {
  const customProfile = !Array.isArray(pack) && typeof pack === "object"
    ? (pack as PetIdleActionProfile)
    : undefined;
  const actions: readonly PetIdleAction[] = customProfile
    ? customProfile.actions
    : Array.isArray(pack)
      ? pack as readonly PetIdleAction[]
      : hour >= 22 || hour < 7
        ? quietIdleActions
        : pack === "calm"
          ? calmIdleActions
          : pack === "playful"
            ? playfulIdleActions
            : pack === "focused"
              ? focusedIdleActions
              : idlePetActions;
  const safeSeed = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 0;
  if (actions.length === 0) return "idle";
  const weights = customProfile?.weights;
  if (!weights) return actions[safeSeed % actions.length] ?? "idle";
  const totalWeight = actions.reduce((total, action) => {
    const weight = weights[action];
    return total + (Number.isFinite(weight) && (weight as number) > 0 ? Math.floor(weight as number) : 1);
  }, 0);
  let cursor = safeSeed % totalWeight;
  for (const action of actions) {
    const weight = weights[action];
    cursor -= Number.isFinite(weight) && (weight as number) > 0 ? Math.floor(weight as number) : 1;
    if (cursor < 0) return action;
  }
  return actions[actions.length - 1] ?? "idle";
}

export function interactionResponse(
  kind: PetInteractionKind,
  name: string,
): PetInteractionResponse {
  const safeName = name.trim() || "小序";
  if (kind === "head-pat" || kind === "pet") {
    return {
      action: "pet",
      emotion: "happy",
      message: "嗯，再摸一下也可以。",
      durationMs: petActionDefinitions.pet.durationMs,
    };
  }
  if (kind === "belly-poke") {
    return {
      action: "poke",
      emotion: "curious",
      message: "咦？你戳到我的任务章啦。",
      durationMs: petActionDefinitions.poke.durationMs,
    };
  }
  if (kind === "high-five") {
    return {
      action: "high-five",
      emotion: "proud",
      message: "击掌！下一件也一起拿下。",
      durationMs: petActionDefinitions["high-five"].durationMs,
    };
  }
  if (kind === "tickle") {
    return {
      action: "tickle",
      emotion: "excited",
      message: "哈哈，先停一下！",
      durationMs: petActionDefinitions.tickle.durationMs,
    };
  }
  if (kind === "treat") {
    return {
      action: "snack",
      emotion: "happy",
      message: "咔嚓，谢谢你。下一件小事我们也一起做。",
      durationMs: petActionDefinitions.snack.durationMs,
    };
  }
  if (kind === "play") {
    return {
      action: "play",
      emotion: "excited",
      message: "接住毛线球！",
      durationMs: petActionDefinitions.play.durationMs,
    };
  }
  if (kind === "rest") {
    return {
      action: "drink",
      emotion: "calm",
      message: "我们一起喝口水，活动一下肩膀。",
      durationMs: 4_200,
    };
  }
  if (kind === "morning") {
    return {
      action: "stretch",
      emotion: "happy",
      message: "早上好。先看最重要的一件事就够了。",
      durationMs: 4_600,
    };
  }
  if (kind === "evening") {
    return {
      action: "sit",
      emotion: "calm",
      message: "今天辛苦了。没做完的事可以交给明天。",
      durationMs: 4_800,
    };
  }
  return {
    action: "wave",
    emotion: "happy",
    message: `${safeName}在这里。`,
    durationMs: petActionDefinitions.wave.durationMs,
  };
}

export function petInteractionFromPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
): PetInteractionKind {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (y <= 0.43) return "head-pat";
  if (y >= 0.76) return "tickle";
  if ((x <= 0.28 || x >= 0.72) && y >= 0.4 && y <= 0.76) return "high-five";
  if (x >= 0.34 && x <= 0.66 && y >= 0.43 && y <= 0.76) return "belly-poke";
  return "pet";
}

export function canInterruptPetAction(current: PetAction, next: PetAction): boolean {
  const currentDefinition = petActionDefinitions[current];
  const nextDefinition = petActionDefinitions[next];
  return currentDefinition.interruptible || nextDefinition.priority >= currentDefinition.priority;
}

export function isProtectedPetAction(action: PetAction): boolean {
  return !petActionDefinitions[action].interruptible;
}

export function idleActionDelayMs(seed: number, cooldownMs?: number): number {
  const safeSeed = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 0;
  return boundedIdleCooldownMs(cooldownMs) + (safeSeed % 12_001);
}

export function idleActionDurationMs(action: PetAction): number {
  return petActionDefinitions[action].durationMs || 2_400;
}
