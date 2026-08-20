import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Task, TaskPriority } from "../../src/shared/models";
import {
  defaultFocusPreset,
  type FocusHistoryRecord,
  type FocusPhase,
  type FocusPreset,
  type FocusSession,
  type FocusSessionView,
  type PetDiaryEntry,
  type PetAdventure,
  type PetCustomizationPatch,
  type PetEvent,
  type PetMemoryEntry,
  type PetMiniGameRecord,
  type PetProfile,
  type ProactiveMessageRecord,
  type PetReward,
  type PetSnapshot,
  type PetState,
  type StartFocusRequest,
} from "../../src/shared/pet-types";

const clone = <T>(value: T): T => structuredClone(value);
const isoNow = (now = Date.now()): string => new Date(now).toISOString();

function createProfile(name: string, now = Date.now()): PetProfile {
  const timestamp = isoNow(now);
  return {
    id: randomUUID(),
    name: name.trim() || "小序",
    species: "task-sprite",
    stage: "seed",
    level: 1,
    experience: 0,
    intimacy: 0,
    attributes: {
      knowledge: 0,
      energy: 0,
      creativity: 0,
      organization: 0,
      courage: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createDefaultPetState(name = "小序", now = Date.now()): PetState {
  const timestamp = isoNow(now);
  return {
    schemaVersion: 1,
    revision: 0,
    profile: createProfile(name, now),
    focusHistory: [],
    rewards: [],
    inventory: [
      { id: "outfit-scarf", quantity: 1, unlockedAt: timestamp },
      { id: "toy-ball", quantity: 1, unlockedAt: timestamp },
      { id: "decoration-cloud-lamp", quantity: 1, unlockedAt: timestamp },
    ],
    appearance: {
      palette: "lavender",
      outfit: "none",
      roomTheme: "cloud-room",
      decorations: ["cloud-lamp"],
    },
    adventures: [],
    miniGames: [],
    diary: [],
    memories: [],
    proactiveMessages: [],
  };
}

function normalizePreset(input?: FocusPreset): FocusPreset {
  const preset = input ?? defaultFocusPreset;
  const integer = (value: number, minimum: number, maximum: number): number => {
    if (!Number.isFinite(value)) throw new Error("INVALID_FOCUS_PRESET");
    return Math.min(maximum, Math.max(minimum, Math.round(value)));
  };
  return {
    focusMinutes: integer(preset.focusMinutes, 1, 240),
    shortBreakMinutes: integer(preset.shortBreakMinutes, 1, 60),
    longBreakMinutes: integer(preset.longBreakMinutes, 1, 120),
    cycles: integer(preset.cycles, 1, 12),
  };
}

function phaseTargetSeconds(phase: FocusPhase, preset: FocusPreset): number {
  if (phase === "focus") return preset.focusMinutes * 60;
  if (phase === "short-break") return preset.shortBreakMinutes * 60;
  return preset.longBreakMinutes * 60;
}

function elapsedSeconds(session: FocusSession, now = Date.now()): number {
  const runningSeconds =
    session.status === "running" && session.startedAt
      ? Math.max(
          0,
          Math.floor((now - new Date(session.startedAt).getTime()) / 1_000),
        )
      : 0;
  return Math.max(0, session.accumulatedSeconds + runningSeconds);
}

function viewFocus(session: FocusSession, now = Date.now()): FocusSessionView {
  const elapsed = elapsedSeconds(session, now);
  const remaining =
    session.targetSeconds === undefined
      ? undefined
      : Math.max(0, session.targetSeconds - elapsed);
  return {
    ...clone(session),
    elapsedSeconds: elapsed,
    remainingSeconds: remaining,
    expectedEndAt:
      session.status === "running" && remaining !== undefined
        ? isoNow(now + remaining * 1_000)
        : undefined,
  };
}

function normalizeState(value: unknown, name: string): PetState {
  if (!value || typeof value !== "object") return createDefaultPetState(name);
  const raw = value as Partial<PetState>;
  if (raw.schemaVersion !== 1 || !raw.profile) return createDefaultPetState(name);
  const defaults = createDefaultPetState(name);
  return {
    ...defaults,
    ...clone(raw),
    schemaVersion: 1,
    revision:
      Number.isInteger(raw.revision) && Number(raw.revision) >= 0
        ? Number(raw.revision)
        : 0,
    profile: {
      ...defaults.profile,
      ...clone(raw.profile),
      attributes: {
        ...defaults.profile.attributes,
        ...clone(raw.profile.attributes ?? {}),
      },
    },
    focusHistory: Array.isArray(raw.focusHistory) ? clone(raw.focusHistory) : [],
    rewards: Array.isArray(raw.rewards) ? clone(raw.rewards) : [],
    inventory: Array.isArray(raw.inventory) ? clone(raw.inventory) : [],
    appearance: {
      ...defaults.appearance,
      ...clone(raw.appearance ?? {}),
      decorations: Array.isArray(raw.appearance?.decorations)
        ? clone(raw.appearance.decorations)
        : defaults.appearance.decorations,
    },
    adventures: Array.isArray(raw.adventures) ? clone(raw.adventures) : [],
    miniGames: Array.isArray(raw.miniGames) ? clone(raw.miniGames) : [],
    diary: Array.isArray(raw.diary)
      ? raw.diary.map((entry) => ({
          ...clone(entry),
          taskIds: Array.isArray(entry.taskIds)
            ? [...new Set(entry.taskIds.filter((id) => typeof id === "string" && id.trim()))]
            : undefined,
        }))
      : [],
    memories: Array.isArray(raw.memories) ? clone(raw.memories) : [],
    proactiveMessages: Array.isArray(raw.proactiveMessages)
      ? clone(raw.proactiveMessages)
      : [],
  };
}

async function atomicWrite(filePath: string, value: PetState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

export interface PetServiceOptions {
  userDataPath: string;
  initialName?: string;
  now?: () => number;
  onEvent?: (event: PetEvent) => void;
}

export interface DiaryFacts {
  localDate: string;
  completedTasks: Array<Pick<Task, "id" | "title">>;
  weatherSummary?: string;
  userNote?: string;
}

export interface DiaryTaskFacts {
  localDate: string;
  task: Pick<Task, "id" | "title" | "status">;
  userNote?: string;
}

export class PetService {
  readonly #filePath: string;
  readonly #now: () => number;
  readonly #onEvent?: (event: PetEvent) => void;
  readonly #initialName: string;
  #state: PetState;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: PetServiceOptions) {
    this.#filePath = path.join(options.userDataPath, "pet", "pet-state.v1.json");
    this.#now = options.now ?? Date.now;
    this.#onEvent = options.onEvent;
    this.#initialName = options.initialName?.trim() || "小序";
    this.#state = createDefaultPetState(this.#initialName, this.#now());
  }

  async initialize(): Promise<PetSnapshot> {
    try {
      const raw = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      this.#state = normalizeState(raw, this.#initialName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(this.#filePath, this.#state);
    }
    return this.snapshot();
  }

  snapshot(now = this.#now()): PetSnapshot {
    const { focus, ...state } = clone(this.#state);
    return {
      ...state,
      focus: focus ? viewFocus(focus, now) : undefined,
    };
  }

  async rename(name: string): Promise<PetSnapshot> {
    const next = name.trim().slice(0, 80);
    if (!next) throw new Error("EMPTY_PET_NAME");
    return this.#mutate((draft, now) => {
      draft.profile.name = next;
      draft.profile.updatedAt = isoNow(now);
    });
  }

  async customize(patch: PetCustomizationPatch): Promise<PetSnapshot> {
    const palettes = new Set(["lavender", "mint", "sunset", "midnight"]);
    const outfits = new Set(["none", "scarf", "explorer", "starlight"]);
    const rooms = new Set(["cloud-room", "forest-nook", "night-library"]);
    return this.#mutate((draft, now, events) => {
      if (patch.palette !== undefined) {
        if (!palettes.has(patch.palette)) throw new Error("INVALID_PET_PALETTE");
        draft.appearance.palette = patch.palette;
      }
      if (patch.outfit !== undefined) {
        if (!outfits.has(patch.outfit)) throw new Error("INVALID_PET_OUTFIT");
        draft.appearance.outfit = patch.outfit;
        draft.profile.equippedOutfit =
          patch.outfit === "none" ? undefined : patch.outfit;
      }
      if (patch.roomTheme !== undefined) {
        if (!rooms.has(patch.roomTheme)) throw new Error("INVALID_PET_ROOM");
        draft.appearance.roomTheme = patch.roomTheme;
      }
      if (patch.decorations !== undefined) {
        draft.appearance.decorations = Array.from(
          new Set(
            patch.decorations
              .map((item) => item.trim().slice(0, 80))
              .filter(Boolean),
          ),
        ).slice(0, 12);
      }
      draft.profile.updatedAt = isoNow(now);
      events.push({ type: "customization-changed", at: isoNow(now) });
    });
  }

  async dailyAdventure(localDate = isoNow(this.#now()).slice(0, 10)): Promise<PetAdventure> {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(localDate)
      ? localDate
      : isoNow(this.#now()).slice(0, 10);
    const existing = this.#state.adventures.find(
      (adventure) => adventure.localDate === date,
    );
    if (existing) return clone(existing);
    let result!: PetAdventure;
    await this.#mutate((draft, now) => {
      const current = draft.adventures.find(
        (adventure) => adventure.localDate === date,
      );
      if (current) {
        result = clone(current);
        return;
      }
      result = createDailyAdventure(date, now, draft.profile.name);
      draft.adventures.unshift(result);
      draft.adventures = draft.adventures.slice(0, 180);
    });
    return clone(result);
  }

  async completeAdventure(
    adventureId: string,
    choiceId: string,
  ): Promise<PetSnapshot> {
    return this.#mutate((draft, now, events) => {
      const adventure = draft.adventures.find(
        (entry) => entry.id === adventureId,
      );
      if (!adventure) throw new Error("PET_ADVENTURE_NOT_FOUND");
      const choice = adventure.choices.find((entry) => entry.id === choiceId);
      if (!choice) throw new Error("PET_ADVENTURE_CHOICE_NOT_FOUND");
      if (adventure.completedAt) return;
      adventure.selectedChoiceId = choice.id;
      adventure.outcome = adventureOutcome(choice.id, draft.profile.name);
      adventure.completedAt = isoNow(now);
      const reward = this.#grantReward(
        draft,
        {
          idempotencyKey: `adventure:${adventure.localDate}`,
          source: "adventure",
          sourceId: adventure.id,
          experience: 6,
          intimacy: 2,
          attribute:
            choice.id === "explore"
              ? "courage"
              : choice.id === "organize"
                ? "organization"
                : "creativity",
          attributePoints: 1,
          itemId: "adventure-star",
        },
        now,
      );
      adventure.rewardId = reward.id;
      addInventoryItem(draft, "adventure-star", now, 1);
      addInventoryItem(draft, "outfit-explorer", now);
      addInventoryItem(draft, "decoration-books", now);
      addInventoryItem(draft, "action-inspect", now);
      events.push({ type: "reward-granted", at: isoNow(now), reward });
      events.push({ type: "adventure-completed", at: isoNow(now) });
    });
  }

  async recordMiniGame(input: {
    game: PetMiniGameRecord["game"];
    score: number;
    durationSeconds: number;
  }): Promise<PetSnapshot> {
    return this.#mutate((draft, now, events) => {
      const completedAt = isoNow(now);
      const record: PetMiniGameRecord = {
        id: randomUUID(),
        game: input.game,
        score: Math.min(99_999, Math.max(0, Math.round(input.score))),
        durationSeconds: Math.min(
          3_600,
          Math.max(1, Math.round(input.durationSeconds)),
        ),
        completedAt,
      };
      draft.miniGames.unshift(record);
      draft.miniGames = draft.miniGames.slice(0, 500);
      if (record.game === "breathing" || record.game === "stretch-mirror") {
        addInventoryItem(draft, "decoration-plant", now);
        addInventoryItem(draft, "prop-teacup", now);
      } else if (record.score >= 1) {
        addInventoryItem(draft, "outfit-starlight", now);
        addInventoryItem(draft, "action-dance", now);
      }
      const day = completedAt.slice(0, 10);
      const key = `game:${day}:${record.game}`;
      if (!draft.rewards.some((reward) => reward.idempotencyKey === key)) {
        const reward = this.#grantReward(
          draft,
          {
            idempotencyKey: key,
            source: "game",
            sourceId: record.id,
            experience: 3,
            intimacy: 1,
            attribute:
              record.game === "breathing" || record.game === "stretch-mirror"
                ? "energy"
                : record.game === "jump-rope"
                  ? "courage"
                  : "creativity",
            attributePoints: 1,
          },
          now,
        );
        events.push({ type: "reward-granted", at: completedAt, reward });
      }
      events.push({ type: "mini-game-completed", at: completedAt });
    });
  }

  async recordProactiveMessage(
    input: Pick<ProactiveMessageRecord, "kind" | "reason" | "dismissed">,
    options?: {
      /** Maximum records for the local day; 0 or omitted means unlimited. */
      dailyLimit?: number;
      /** Main-process local date, supplied by the settings/runtime owner. */
      localDate?: string;
    },
  ): Promise<PetSnapshot> {
    return this.#mutate((draft, now) => {
      const dailyLimit = typeof options?.dailyLimit === "number" &&
        Number.isFinite(options.dailyLimit) && options.dailyLimit > 0
        ? Math.floor(options.dailyLimit)
        : 0;
      if (dailyLimit > 0) {
        const date = options?.localDate ?? isoNow(now).slice(0, 10);
        const shownToday = draft.proactiveMessages.filter((message) =>
          message.shownAt.slice(0, 10) === date,
        ).length;
        if (shownToday >= dailyLimit) return;
      }
      draft.proactiveMessages.unshift({
        id: randomUUID(),
        kind: input.kind,
        reason: input.reason.trim().slice(0, 500),
        dismissed: input.dismissed,
        shownAt: isoNow(now),
      });
      draft.proactiveMessages = draft.proactiveMessages.slice(0, 500);
    });
  }

  async startFocus(request: StartFocusRequest): Promise<PetSnapshot> {
    return this.#mutate((draft, now) => {
      if (draft.focus) throw new Error("FOCUS_SESSION_ALREADY_ACTIVE");
      const preset = normalizePreset(request.preset);
      const createdAt = isoNow(now);
      draft.focus = {
        id: randomUUID(),
        mode: request.mode,
        phase: "focus",
        status: "running",
        taskId: request.taskId,
        taskTitle: request.taskTitle?.trim().slice(0, 500),
        preset,
        cycle: 1,
        startedAt: createdAt,
        accumulatedSeconds: 0,
        targetSeconds:
          request.mode === "pomodoro"
            ? phaseTargetSeconds("focus", preset)
            : undefined,
        autoStartBreak: request.autoStartBreak ?? false,
        autoStartNextRound: request.autoStartNextRound ?? false,
        interruptions: [],
        createdAt,
        updatedAt: createdAt,
      };
    });
  }

  async pauseFocus(reason?: string): Promise<PetSnapshot> {
    return this.#mutate((draft, now) => {
      const session = draft.focus;
      if (!session || session.status !== "running")
        throw new Error("FOCUS_SESSION_NOT_RUNNING");
      session.accumulatedSeconds = elapsedSeconds(session, now);
      session.startedAt = undefined;
      session.status = "paused";
      session.updatedAt = isoNow(now);
      if (reason?.trim()) {
        session.interruptions.push({
          at: isoNow(now),
          reason: reason.trim().slice(0, 240),
        });
      }
    });
  }

  async resumeFocus(): Promise<PetSnapshot> {
    return this.#mutate((draft, now) => {
      const session = draft.focus;
      if (!session || session.status !== "paused")
        throw new Error("FOCUS_SESSION_NOT_PAUSED");
      session.status = "running";
      session.startedAt = isoNow(now);
      session.updatedAt = isoNow(now);
    });
  }

  async advanceFocus(): Promise<PetSnapshot> {
    return this.#mutate((draft, now, events) => {
      const session = draft.focus;
      if (!session || session.status !== "awaiting-completion")
        throw new Error("FOCUS_SESSION_NOT_AWAITING_COMPLETION");
      this.#advanceSession(draft, session, now, events);
    });
  }

  async finishFocus(
    outcome: "completed" | "abandoned",
  ): Promise<PetSnapshot> {
    return this.#mutate((draft, now, events) => {
      const session = draft.focus;
      if (!session) throw new Error("FOCUS_SESSION_NOT_ACTIVE");
      const actualSeconds = elapsedSeconds(session, now);
      const history = this.#appendFocusHistory(
        draft,
        session,
        actualSeconds,
        outcome,
        now,
      );
      if (outcome === "completed" && session.phase === "focus") {
        this.#grantFocusReward(draft, session, history, now, events);
      }
      draft.focus = undefined;
    });
  }

  async tick(): Promise<PetEvent[]> {
    const current = this.#state.focus;
    if (
      !current ||
      current.status !== "running" ||
      current.targetSeconds === undefined ||
      elapsedSeconds(current, this.#now()) < current.targetSeconds
    ) {
      return [];
    }
    const events: PetEvent[] = [];
    await this.#mutate((draft, now, nextEvents) => {
      const session = draft.focus;
      if (
        !session ||
        session.status !== "running" ||
        session.targetSeconds === undefined
      ) {
        return;
      }
      const elapsed = elapsedSeconds(session, now);
      if (elapsed < session.targetSeconds) return;

      session.accumulatedSeconds = session.targetSeconds;
      session.startedAt = undefined;
      session.status = "awaiting-completion";
      session.updatedAt = isoNow(now);
      const history = this.#appendFocusHistory(
        draft,
        session,
        session.targetSeconds,
        "completed",
        now,
      );
      if (session.phase === "focus") {
        this.#grantFocusReward(draft, session, history, now, nextEvents);
      }
      nextEvents.push({
        type: "focus-phase-completed",
        at: isoNow(now),
        focus: viewFocus(session, now),
      });

      const shouldAutoAdvance =
        session.phase === "focus"
          ? session.autoStartBreak
          : session.autoStartNextRound;
      if (shouldAutoAdvance) this.#advanceSession(draft, session, now, nextEvents);
    }, events);
    return events;
  }

  async reconcileCompletedTasks(tasks: readonly Task[]): Promise<PetSnapshot> {
    return this.#mutate((draft, now, events) => {
      for (const task of tasks) {
        if (task.status !== "completed" || !task.completedAt) continue;
        const key = `task:${task.id}:completed`;
        if (draft.rewards.some((reward) => reward.idempotencyKey === key))
          continue;
        const reward = this.#grantReward(
          draft,
          {
            idempotencyKey: key,
            source: "task",
            sourceId: task.id,
            experience: taskExperience(task.priority),
            intimacy: 1,
            attribute: "organization",
            attributePoints: task.priority === "urgent" ? 2 : 1,
          },
          now,
        );
        events.push({ type: "reward-granted", at: isoNow(now), reward });
      }
    });
  }

  async generateDiary(facts: DiaryFacts): Promise<PetDiaryEntry> {
    let result!: PetDiaryEntry;
    await this.#mutate((draft, now) => {
      const dayHistory = draft.focusHistory.filter(
        (record) => record.completedAt.slice(0, 10) === facts.localDate,
      );
      const focusRounds = dayHistory.filter(
        (record) => record.phase === "focus" && record.outcome === "completed",
      );
      const rewards = draft.rewards.filter(
        (reward) => reward.grantedAt.slice(0, 10) === facts.localDate,
      );
      const taskNames = facts.completedTasks
        .slice(0, 3)
        .map((task) => `“${task.title}”`)
        .join("、");
      const content = [
        facts.completedTasks.length
          ? `今天我们一起完成了 ${facts.completedTasks.length} 件事${taskNames ? `，包括 ${taskNames}` : ""}。`
          : "今天没有勉强赶进度，留白也是计划的一部分。",
        focusRounds.length
          ? `共同专注 ${focusRounds.length} 轮，共 ${Math.round(focusRounds.reduce((sum, entry) => sum + entry.actualSeconds, 0) / 60)} 分钟。`
          : "今天还没有完整的专注轮次。",
        rewards.length ? `小窝收到了 ${rewards.length} 份成长记录。` : "",
        facts.weatherSummary ? `天气片段：${facts.weatherSummary}。` : "",
        facts.userNote?.trim() ? `你的备注：${facts.userNote.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const existing = draft.diary.find(
        (entry) =>
          entry.localDate === facts.localDate &&
          entry.generation === "local-template" &&
          !entry.userEdited,
      );
      result = {
        id: existing?.id ?? randomUUID(),
        localDate: facts.localDate,
        title: `${facts.localDate} · 和${draft.profile.name}的一天`,
        content,
        taskIds: [...new Set(facts.completedTasks.map((task) => task.id))],
        generation: "local-template",
        completedTaskCount: facts.completedTasks.length,
        focusRounds: focusRounds.length,
        focusSeconds: focusRounds.reduce(
          (sum, entry) => sum + entry.actualSeconds,
          0,
        ),
        rewardIds: rewards.map((reward) => reward.id),
        weatherSummary: facts.weatherSummary,
        userEdited: false,
        createdAt: existing?.createdAt ?? isoNow(now),
        updatedAt: isoNow(now),
      };
      draft.diary = [
        ...draft.diary.filter((entry) => entry.id !== result.id),
        result,
      ].sort((a, b) => b.localDate.localeCompare(a.localDate));
    });
    return clone(result);
  }

  async createDiaryFromTask(facts: DiaryTaskFacts): Promise<PetDiaryEntry> {
    let result!: PetDiaryEntry;
    await this.#mutate((draft, now) => {
      const localDate = /^\d{4}-\d{2}-\d{2}$/u.test(facts.localDate)
        ? facts.localDate
        : isoNow(now).slice(0, 10);
      const taskId = facts.task.id;
      const existing = draft.diary.find(
        (entry) =>
          entry.generation === "user" &&
          !entry.userEdited &&
          entry.taskIds?.length === 1 &&
          entry.taskIds[0] === taskId,
      );
      const focusRounds = draft.focusHistory.filter(
        (record) =>
          record.taskId === taskId &&
          record.phase === "focus" &&
          record.outcome === "completed",
      );
      const statusLine =
        facts.task.status === "completed"
          ? `今天我们一起完成了“${facts.task.title}”。`
          : `我们把“${facts.task.title}”记进了共同日记，下一步可以从这里继续。`;
      const content = [
        statusLine,
        focusRounds.length
          ? `这项任务一起专注了 ${focusRounds.length} 轮，共 ${Math.round(focusRounds.reduce((sum, record) => sum + record.actualSeconds, 0) / 60)} 分钟。`
          : "这次没有完整的专注轮次，也没关系。",
        facts.userNote?.trim() ? `你的备注：${facts.userNote.trim().slice(0, 2_000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      result = {
        id: existing?.id ?? randomUUID(),
        localDate,
        title: `${localDate} · ${facts.task.title}`.slice(0, 200),
        content,
        taskIds: [taskId],
        generation: "user",
        completedTaskCount: facts.task.status === "completed" ? 1 : 0,
        focusRounds: focusRounds.length,
        focusSeconds: focusRounds.reduce((sum, record) => sum + record.actualSeconds, 0),
        rewardIds: [],
        userEdited: existing?.userEdited ?? false,
        createdAt: existing?.createdAt ?? isoNow(now),
        updatedAt: isoNow(now),
      };
      draft.diary = [
        ...draft.diary.filter((entry) => entry.id !== result.id),
        result,
      ].sort((left, right) => right.localDate.localeCompare(left.localDate));
    });
    return clone(result);
  }

  async updateDiary(
    id: string,
    patch: Pick<PetDiaryEntry, "title" | "content">,
  ): Promise<PetDiaryEntry> {
    let result!: PetDiaryEntry;
    await this.#mutate((draft, now) => {
      const entry = draft.diary.find((candidate) => candidate.id === id);
      if (!entry) throw new Error("DIARY_ENTRY_NOT_FOUND");
      entry.title = patch.title.trim().slice(0, 200);
      entry.content = patch.content.trim().slice(0, 50_000);
      entry.userEdited = true;
      entry.updatedAt = isoNow(now);
      result = clone(entry);
    });
    return result;
  }

  async deleteDiary(id: string): Promise<boolean> {
    let deleted = false;
    await this.#mutate((draft) => {
      const next = draft.diary.filter((entry) => entry.id !== id);
      deleted = next.length !== draft.diary.length;
      draft.diary = next;
    });
    return deleted;
  }

  async addMemory(
    input: Pick<PetMemoryEntry, "kind" | "content">,
  ): Promise<PetMemoryEntry> {
    let result!: PetMemoryEntry;
    await this.#mutate((draft, now) => {
      const content = input.content.trim().slice(0, 2_000);
      if (!content) throw new Error("EMPTY_MEMORY");
      result = {
        id: randomUUID(),
        kind: input.kind,
        content,
        enabled: true,
        approvedByUser: true,
        createdAt: isoNow(now),
        updatedAt: isoNow(now),
      };
      draft.memories.unshift(result);
    });
    return clone(result);
  }

  async updateMemory(
    id: string,
    patch: Partial<Pick<PetMemoryEntry, "content" | "enabled">>,
  ): Promise<PetMemoryEntry> {
    let result!: PetMemoryEntry;
    await this.#mutate((draft, now) => {
      const memory = draft.memories.find((entry) => entry.id === id);
      if (!memory) throw new Error("MEMORY_NOT_FOUND");
      if (patch.content !== undefined) {
        const content = patch.content.trim().slice(0, 2_000);
        if (!content) throw new Error("EMPTY_MEMORY");
        memory.content = content;
      }
      if (patch.enabled !== undefined) memory.enabled = patch.enabled;
      memory.updatedAt = isoNow(now);
      result = clone(memory);
    });
    return result;
  }

  async deleteMemory(id: string): Promise<boolean> {
    let deleted = false;
    await this.#mutate((draft) => {
      const next = draft.memories.filter((entry) => entry.id !== id);
      deleted = next.length !== draft.memories.length;
      draft.memories = next;
    });
    return deleted;
  }

  async recordInteraction(kind = "pet"): Promise<PetSnapshot> {
    return this.#mutate((draft, now, events) => {
      const day = isoNow(now).slice(0, 10);
      const key = `interaction:${day}:${kind}`;
      if (draft.rewards.some((reward) => reward.idempotencyKey === key)) return;
      const reward = this.#grantReward(
        draft,
        {
          idempotencyKey: key,
          source: "interaction",
          sourceId: kind,
          experience: 1,
          intimacy: 1,
        },
        now,
      );
      events.push({ type: "reward-granted", at: isoNow(now), reward });
    });
  }

  #advanceSession(
    draft: PetState,
    session: FocusSession,
    now: number,
    events: PetEvent[],
  ): void {
    if (session.phase === "focus") {
      session.phase =
        session.cycle >= session.preset.cycles ? "long-break" : "short-break";
    } else if (session.cycle >= session.preset.cycles) {
      draft.focus = undefined;
      return;
    } else {
      session.phase = "focus";
      session.cycle += 1;
    }
    session.status = "running";
    session.startedAt = isoNow(now);
    session.accumulatedSeconds = 0;
    session.targetSeconds = phaseTargetSeconds(session.phase, session.preset);
    session.updatedAt = isoNow(now);
    events.push({
      type: "focus-phase-started",
      at: isoNow(now),
      focus: viewFocus(session, now),
    });
  }

  #appendFocusHistory(
    draft: PetState,
    session: FocusSession,
    actualSeconds: number,
    outcome: FocusHistoryRecord["outcome"],
    now: number,
  ): FocusHistoryRecord {
    const key = `${session.id}:${session.phase}:${session.cycle}:${outcome}`;
    const existing = draft.focusHistory.find((entry) => entry.id === key);
    if (existing) return existing;
    const record: FocusHistoryRecord = {
      id: key,
      sessionId: session.id,
      phase: session.phase,
      cycle: session.cycle,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      plannedSeconds: session.targetSeconds,
      actualSeconds: Math.max(0, Math.round(actualSeconds)),
      outcome,
      completedAt: isoNow(now),
    };
    draft.focusHistory.unshift(record);
    draft.focusHistory = draft.focusHistory.slice(0, 2_000);
    return record;
  }

  #grantFocusReward(
    draft: PetState,
    session: FocusSession,
    history: FocusHistoryRecord,
    now: number,
    events: PetEvent[],
  ): void {
    const key = `focus:${session.id}:${session.cycle}`;
    if (draft.rewards.some((reward) => reward.idempotencyKey === key)) return;
    const minutes = Math.max(1, Math.round(history.actualSeconds / 60));
    const reward = this.#grantReward(
      draft,
      {
        idempotencyKey: key,
        source: "focus",
        sourceId: history.id,
        experience: Math.min(30, Math.max(5, Math.round(minutes / 2))),
        intimacy: 2,
        attribute: "knowledge",
        attributePoints: Math.min(3, Math.max(1, Math.round(minutes / 25))),
      },
      now,
    );
    events.push({ type: "reward-granted", at: isoNow(now), reward });
  }

  #grantReward(
    draft: PetState,
    input: Omit<PetReward, "id" | "grantedAt">,
    now: number,
  ): PetReward {
    const reward: PetReward = {
      ...input,
      id: randomUUID(),
      grantedAt: isoNow(now),
    };
    draft.rewards.unshift(reward);
    draft.rewards = draft.rewards.slice(0, 5_000);
    draft.profile.experience += reward.experience;
    draft.profile.intimacy += reward.intimacy;
    if (reward.attribute && reward.attributePoints) {
      draft.profile.attributes[reward.attribute] += reward.attributePoints;
    }
    draft.profile.level = Math.max(
      1,
      Math.floor(draft.profile.experience / 100) + 1,
    );
    draft.profile.stage =
      draft.profile.level >= 20
        ? "guardian"
        : draft.profile.level >= 10
          ? "partner"
          : draft.profile.level >= 3
            ? "companion"
            : "seed";
    draft.profile.updatedAt = isoNow(now);
    return reward;
  }

  async #mutate(
    mutation: (
      draft: PetState,
      now: number,
      events: PetEvent[],
    ) => void | Promise<void>,
    externalEvents?: PetEvent[],
  ): Promise<PetSnapshot> {
    const operation = this.#queue.then(async () => {
      const draft = clone(this.#state);
      const events = externalEvents ?? [];
      const now = this.#now();
      await mutation(draft, now, events);
      draft.schemaVersion = 1;
      draft.revision = this.#state.revision + 1;
      this.#state = draft;
      await atomicWrite(this.#filePath, draft);
      const snapshot = this.snapshot(now);
      this.#onEvent?.({ type: "state-changed", at: isoNow(now) });
      for (const event of events) this.#onEvent?.(clone(event));
      return snapshot;
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function taskExperience(priority: TaskPriority): number {
  if (priority === "urgent") return 20;
  if (priority === "high") return 15;
  if (priority === "medium") return 10;
  if (priority === "low") return 8;
  return 6;
}

function addInventoryItem(
  draft: PetState,
  id: string,
  now: number,
  quantity = 0,
): void {
  const existing = draft.inventory.find((item) => item.id === id);
  if (existing) {
    if (quantity > 0) existing.quantity += quantity;
    return;
  }
  draft.inventory.push({
    id,
    quantity: Math.max(1, quantity),
    unlockedAt: isoNow(now),
  });
}

const DAILY_ADVENTURES = [
  {
    title: "云朵邮局的慢递",
    prompt: "一封没有收件人的信落在窗边。我们怎么替它找到方向？",
  },
  {
    title: "被风吹乱的任务星图",
    prompt: "今天的任务像星星一样散开了。要和我一起把它们排成星座吗？",
  },
  {
    title: "森林书架的秘密夹层",
    prompt: "小窝的书架响了一声，夹层里藏着一张空白地图。先从哪里开始？",
  },
] as const;

function createDailyAdventure(
  localDate: string,
  now: number,
  petName: string,
): PetAdventure {
  const seed = Array.from(localDate).reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0,
  );
  const template = DAILY_ADVENTURES[seed % DAILY_ADVENTURES.length]!;
  return {
    id: `adventure:${localDate}`,
    localDate,
    title: template.title,
    prompt: `${template.prompt}\n${petName}会陪你一起，不需要连续签到。`,
    choices: [
      { id: "explore", label: "大胆探索" },
      { id: "organize", label: "先整理线索" },
      { id: "imagine", label: "画出新路线" },
    ],
    createdAt: isoNow(now),
  };
}

function adventureOutcome(choiceId: string, petName: string): string {
  if (choiceId === "explore") {
    return `你和${petName}顺着风跑出去，找到了那封信真正想抵达的地方。勇气不是不犹豫，而是一起迈出一步。`;
  }
  if (choiceId === "organize") {
    return `你和${petName}把线索铺成一排，原本混乱的小事渐渐有了方向。今天的秩序来自温柔的整理。`;
  }
  return `你和${petName}画了一条地图上没有的路，意外发现了一片会发光的云。好奇心也值得被记进日记。`;
}
