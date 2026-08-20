import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  defaultSettings,
  FLOATING_HOVER_EXPAND_DELAY_MAX_MS,
  FLOATING_HOVER_EXPAND_DELAY_MIN_MS,
  type AppSettings,
  type PublicCredentialState,
} from '../../src/shared/settings';

export interface EncryptionAdapter {
  isAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface StoredCredential extends PublicCredentialState {
  encryptedValue: string;
}

interface StoredSecrets {
  schemaVersion: 1;
  credentials: StoredCredential[];
}

const clone = <T>(value: T): T => structuredClone(value);
const petTabs = new Set(['all', 'today', 'focus', 'chat', 'home']);
const environmentSounds = new Set(['off', 'rain', 'forest', 'cafe', 'white-noise']);
const petActionPacks = new Set(['balanced', 'calm', 'playful', 'focused']);
const petAnimationIntensities = new Set(['gentle', 'lively']);
const focusShieldModes = new Set(['off', 'gentle', 'pause']);
const aiRoutingModes = new Set(['primary-only', 'fallback-on-error', 'local-only']);
const aiAuthenticationModes = new Set(['bearer', 'none']);
const taskReminderSourceModes = new Set(['normal', 'important-only', 'off']);

function clampInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function clampNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function normalizeModelPricing(
  value: unknown,
  fallback: { promptUsdPerMillionTokens: number; completionUsdPerMillionTokens: number },
): { promptUsdPerMillionTokens: number; completionUsdPerMillionTokens: number } {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    promptUsdPerMillionTokens: clampNumber(
      source.promptUsdPerMillionTokens,
      fallback.promptUsdPerMillionTokens,
      0,
      100_000,
    ),
    completionUsdPerMillionTokens: clampNumber(
      source.completionUsdPerMillionTokens,
      fallback.completionUsdPerMillionTokens,
      0,
      100_000,
    ),
  };
}

function normalizeProjectReminderModes(value: unknown): Record<string, 'normal' | 'important-only' | 'off'> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, 'normal' | 'important-only' | 'off'> = {};
  for (const [rawProjectId, rawMode] of Object.entries(value as Record<string, unknown>)) {
    const projectId = rawProjectId.trim();
    if (!projectId || projectId.length > 512 || normalized[projectId] !== undefined) continue;
    if (typeof rawMode === 'string' && taskReminderSourceModes.has(rawMode)) {
      normalized[projectId] = rawMode as 'normal' | 'important-only' | 'off';
    }
    if (Object.keys(normalized).length >= 100) break;
  }
  return normalized;
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);
}

function mergeSettings(value: Partial<AppSettings> | undefined): AppSettings {
  const merged: AppSettings = {
    ...clone(defaultSettings),
    ...value,
    notifications: { ...defaultSettings.notifications, ...value?.notifications },
    floating: { ...defaultSettings.floating, ...value?.floating },
    focus: { ...defaultSettings.focus, ...value?.focus },
    planning: {
      ...defaultSettings.planning,
      ...value?.planning,
      urgencyWeights: {
        ...defaultSettings.planning.urgencyWeights,
        ...value?.planning?.urgencyWeights,
      },
    },
    weather: { ...defaultSettings.weather, ...value?.weather },
    pet: { ...defaultSettings.pet, ...value?.pet },
    ai: {
      ...defaultSettings.ai,
      ...value?.ai,
      pricing: {
        ...defaultSettings.ai.pricing,
        ...value?.ai?.pricing,
      },
      fallback: {
        ...defaultSettings.ai.fallback,
        ...value?.ai?.fallback,
        pricing: {
          ...defaultSettings.ai.fallback.pricing,
          ...value?.ai?.fallback?.pricing,
        },
      },
    },
    feishu: { ...defaultSettings.feishu, ...value?.feishu },
    modelDataScope: { ...defaultSettings.modelDataScope, ...value?.modelDataScope },
    persona: { ...defaultSettings.persona, ...value?.persona },
    schemaVersion: 1,
  };
  // Early alpha builds defaulted to Relay even though no Relay service was
  // shipped. Migrate only that untouched, unconfigured default; intentional
  // Relay configurations remain unchanged.
  if (
    merged.feishu.mode === 'relay' &&
    !merged.feishu.configured &&
    !merged.feishu.relayBaseUrl &&
    !merged.feishu.clientId
  ) {
    merged.feishu.mode = 'personal-direct';
  }

  merged.floating.hoverExpandDelayMs = Number.isFinite(
    merged.floating.hoverExpandDelayMs,
  )
    ? Math.min(
        FLOATING_HOVER_EXPAND_DELAY_MAX_MS,
        Math.max(
          FLOATING_HOVER_EXPAND_DELAY_MIN_MS,
          Math.round(merged.floating.hoverExpandDelayMs),
        ),
      )
    : defaultSettings.floating.hoverExpandDelayMs;

  // The floating entry is a persistent desktop affordance. Older alpha
  // builds exposed focus-only/never modes, which could make the entry vanish
  // behind ordinary windows. Accept those stored values for compatibility,
  // but normalize them to the current always-on-top product behavior.
  merged.floating.topMode = 'always';
  merged.floating.selectedTab = petTabs.has(merged.floating.selectedTab)
    ? merged.floating.selectedTab
    : 'all';
  merged.floating.scalePercent = Number.isFinite(merged.floating.scalePercent)
    ? Math.min(125, Math.max(75, Math.round(merged.floating.scalePercent)))
    : defaultSettings.floating.scalePercent;
  merged.notifications.dailyTaskReminderLimit = clampInteger(
    merged.notifications.dailyTaskReminderLimit,
    defaultSettings.notifications.dailyTaskReminderLimit,
    0,
    50,
  );
  merged.notifications.taskIgnoreBackoffEnabled =
    typeof merged.notifications.taskIgnoreBackoffEnabled === 'boolean'
      ? merged.notifications.taskIgnoreBackoffEnabled
      : defaultSettings.notifications.taskIgnoreBackoffEnabled;
  merged.notifications.taskReminderMinIntervalMinutes = clampInteger(
    merged.notifications.taskReminderMinIntervalMinutes,
    defaultSettings.notifications.taskReminderMinIntervalMinutes,
    0,
    1_440,
  );
  if (!merged.notifications.taskReminderSourceMode || typeof merged.notifications.taskReminderSourceMode !== 'object') {
    merged.notifications.taskReminderSourceMode = {
      ...defaultSettings.notifications.taskReminderSourceMode,
    };
  } else {
    merged.notifications.taskReminderSourceMode = {
      local: taskReminderSourceModes.has(merged.notifications.taskReminderSourceMode.local)
        ? merged.notifications.taskReminderSourceMode.local
        : defaultSettings.notifications.taskReminderSourceMode.local,
      feishu: taskReminderSourceModes.has(merged.notifications.taskReminderSourceMode.feishu)
        ? merged.notifications.taskReminderSourceMode.feishu
        : defaultSettings.notifications.taskReminderSourceMode.feishu,
    };
  }
  merged.notifications.taskReminderProjectMode = normalizeProjectReminderModes(
    merged.notifications.taskReminderProjectMode,
  );
  merged.focus.focusMinutes = clampInteger(
    merged.focus.focusMinutes,
    defaultSettings.focus.focusMinutes,
    1,
    240,
  );
  merged.focus.shortBreakMinutes = clampInteger(
    merged.focus.shortBreakMinutes,
    defaultSettings.focus.shortBreakMinutes,
    1,
    60,
  );
  merged.focus.longBreakMinutes = clampInteger(
    merged.focus.longBreakMinutes,
    defaultSettings.focus.longBreakMinutes,
    1,
    120,
  );
  merged.focus.cycles = clampInteger(
    merged.focus.cycles,
    defaultSettings.focus.cycles,
    1,
    12,
  );
  if (!environmentSounds.has(merged.focus.environmentSound)) {
    merged.focus.environmentSound = defaultSettings.focus.environmentSound;
  }
  merged.focus.shieldMode = focusShieldModes.has(merged.focus.shieldMode)
    ? merged.focus.shieldMode
    : defaultSettings.focus.shieldMode;
  const shieldApplications = Array.isArray(merged.focus.shieldApplications)
    ? merged.focus.shieldApplications
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().slice(0, 80))
        .filter(Boolean)
    : [];
  const seenShieldApplications = new Set<string>();
  merged.focus.shieldApplications = shieldApplications.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seenShieldApplications.has(key)) return false;
    seenShieldApplications.add(key);
    return true;
  }).slice(0, 12);
  merged.planning.urgencyWeights = {
    deadline: clampInteger(
      merged.planning.urgencyWeights.deadline,
      defaultSettings.planning.urgencyWeights.deadline,
      0,
      100,
    ),
    plannedToday: clampInteger(
      merged.planning.urgencyWeights.plannedToday,
      defaultSettings.planning.urgencyWeights.plannedToday,
      0,
      100,
    ),
    priority: clampInteger(
      merged.planning.urgencyWeights.priority,
      defaultSettings.planning.urgencyWeights.priority,
      0,
      100,
    ),
    quickWin: clampInteger(
      merged.planning.urgencyWeights.quickWin,
      defaultSettings.planning.urgencyWeights.quickWin,
      0,
      100,
    ),
  };
  if (!petActionPacks.has(merged.pet.actionPack)) {
    merged.pet.actionPack = defaultSettings.pet.actionPack;
  }
  if (!petAnimationIntensities.has(merged.pet.animationIntensity)) {
    merged.pet.animationIntensity = defaultSettings.pet.animationIntensity;
  }
  merged.pet.proactiveIntervalMinutes = clampInteger(
    merged.pet.proactiveIntervalMinutes,
    defaultSettings.pet.proactiveIntervalMinutes,
    15,
    240,
  );
  merged.pet.proactiveDailyLimit = clampInteger(
    merged.pet.proactiveDailyLimit,
    defaultSettings.pet.proactiveDailyLimit,
    0,
    20,
  );
  merged.weather.cacheMinutes = clampInteger(
    merged.weather.cacheMinutes,
    defaultSettings.weather.cacheMinutes,
    30,
    120,
  );
  if (!Number.isFinite(merged.weather.latitude)) delete merged.weather.latitude;
  if (!Number.isFinite(merged.weather.longitude)) delete merged.weather.longitude;

  if (!aiRoutingModes.has(merged.ai.routing)) {
    merged.ai.routing = defaultSettings.ai.routing;
  }
  if (!aiAuthenticationModes.has(merged.ai.authMode)) {
    merged.ai.authMode = defaultSettings.ai.authMode;
  }
  merged.ai.pricing = normalizeModelPricing(
    merged.ai.pricing,
    defaultSettings.ai.pricing,
  );
  if (!merged.ai.fallback || typeof merged.ai.fallback !== 'object') {
    merged.ai.fallback = clone(defaultSettings.ai.fallback);
  } else {
    merged.ai.fallback = {
      ...defaultSettings.ai.fallback,
      ...merged.ai.fallback,
    };
    if (!aiAuthenticationModes.has(merged.ai.fallback.authMode)) {
      merged.ai.fallback.authMode = defaultSettings.ai.fallback.authMode;
    }
    merged.ai.fallback.pricing = normalizeModelPricing(
      merged.ai.fallback.pricing,
      defaultSettings.ai.fallback.pricing,
    );
  }

  // Keep the ordinary settings document on an explicit allow-list. Types and
  // the renderer IPC schema are useful boundaries, but callers in the main
  // process can still pass runtime objects at execution time. In particular,
  // an accidental `clientSecret`, `accessToken`, or `refreshToken` property
  // must never be retained by object spread and written to settings.v1.json.
  return {
    schemaVersion: 1,
    theme: merged.theme,
    launchAtLogin: merged.launchAtLogin,
    closeToTray: merged.closeToTray,
    quickCaptureShortcut: merged.quickCaptureShortcut,
    notifications: {
      enabled: merged.notifications.enabled,
      sound: merged.notifications.sound,
      banners: merged.notifications.banners,
      badge: merged.notifications.badge,
      morningBrief: merged.notifications.morningBrief,
      morningBriefTime: merged.notifications.morningBriefTime,
      quietHoursEnabled: merged.notifications.quietHoursEnabled,
      quietHoursStart: merged.notifications.quietHoursStart,
      quietHoursEnd: merged.notifications.quietHoursEnd,
      dailyTaskReminderLimit: merged.notifications.dailyTaskReminderLimit,
      taskIgnoreBackoffEnabled: merged.notifications.taskIgnoreBackoffEnabled,
      taskReminderMinIntervalMinutes: merged.notifications.taskReminderMinIntervalMinutes,
      taskReminderSourceMode: {
        local: merged.notifications.taskReminderSourceMode.local,
        feishu: merged.notifications.taskReminderSourceMode.feishu,
      },
      taskReminderProjectMode: clone(merged.notifications.taskReminderProjectMode),
      mutedUntil: merged.notifications.mutedUntil,
    },
    floating: {
      enabled: merged.floating.enabled,
      hoverExpandDelayMs: merged.floating.hoverExpandDelayMs,
      topMode: merged.floating.topMode,
      locked: merged.floating.locked,
      hideInFullscreen: merged.floating.hideInFullscreen,
      privacyMode: merged.floating.privacyMode,
      selectedTab: merged.floating.selectedTab,
      scalePercent: merged.floating.scalePercent,
      lastDisplayId: merged.floating.lastDisplayId,
      positions: clone(merged.floating.positions),
    },
    focus: {
      focusMinutes: merged.focus.focusMinutes,
      shortBreakMinutes: merged.focus.shortBreakMinutes,
      longBreakMinutes: merged.focus.longBreakMinutes,
      cycles: merged.focus.cycles,
      autoStartBreak: merged.focus.autoStartBreak,
      autoStartNextRound: merged.focus.autoStartNextRound,
      environmentSound: merged.focus.environmentSound,
      shieldMode: merged.focus.shieldMode,
      shieldApplications: [...merged.focus.shieldApplications],
    },
    planning: {
      urgencyWeights: {
        deadline: merged.planning.urgencyWeights.deadline,
        plannedToday: merged.planning.urgencyWeights.plannedToday,
        priority: merged.planning.urgencyWeights.priority,
        quickWin: merged.planning.urgencyWeights.quickWin,
      },
    },
    weather: {
      enabled: merged.weather.enabled,
      city: merged.weather.city,
      latitude: merged.weather.latitude,
      longitude: merged.weather.longitude,
      resolvedName: merged.weather.resolvedName,
      cacheMinutes: merged.weather.cacheMinutes,
    },
    pet: {
      interactionsEnabled: merged.pet.interactionsEnabled,
      proactiveMessages: merged.pet.proactiveMessages,
      wellbeingReminders: merged.pet.wellbeingReminders,
      autoDiary: merged.pet.autoDiary,
      relationshipMemory: merged.pet.relationshipMemory,
      actionPack: merged.pet.actionPack,
      animationIntensity: merged.pet.animationIntensity,
      proactiveIntervalMinutes: merged.pet.proactiveIntervalMinutes,
      proactiveDailyLimit: merged.pet.proactiveDailyLimit,
      meetingMode: merged.pet.meetingMode,
      seasonalEvents: merged.pet.seasonalEvents,
    },
    ai: {
      enabled: merged.ai.enabled,
      endpoint: merged.ai.endpoint,
      model: merged.ai.model,
      authMode: merged.ai.authMode,
      routing: merged.ai.routing,
      fallback: {
        enabled: merged.ai.fallback.enabled,
        endpoint: merged.ai.fallback.endpoint,
        model: merged.ai.fallback.model,
        authMode: merged.ai.fallback.authMode,
        pricing: {
          promptUsdPerMillionTokens:
            merged.ai.fallback.pricing.promptUsdPerMillionTokens,
          completionUsdPerMillionTokens:
            merged.ai.fallback.pricing.completionUsdPerMillionTokens,
        },
        credentialId: merged.ai.fallback.credentialId,
      },
      timeoutMs: merged.ai.timeoutMs,
      retries: merged.ai.retries,
      dailyTokenLimit: merged.ai.dailyTokenLimit,
      dailyCostLimit: merged.ai.dailyCostLimit,
      pricing: {
        promptUsdPerMillionTokens: merged.ai.pricing.promptUsdPerMillionTokens,
        completionUsdPerMillionTokens: merged.ai.pricing.completionUsdPerMillionTokens,
      },
      credentialId: merged.ai.credentialId,
    },
    feishu: {
      configured: merged.feishu.configured,
      mode: merged.feishu.mode,
      accountId: merged.feishu.accountId,
      tokenCredentialId: merged.feishu.tokenCredentialId,
      relayBaseUrl: merged.feishu.relayBaseUrl,
      clientId: merged.feishu.clientId,
      appSecretCredentialId: merged.feishu.appSecretCredentialId,
      acknowledgeInsecureLocalCredentials:
        merged.feishu.acknowledgeInsecureLocalCredentials,
      autoSync: merged.feishu.autoSync,
      pollingMinutes: merged.feishu.pollingMinutes,
    },
    modelDataScope: {
      taskTitlesAndTimes: merged.modelDataScope.taskTitlesAndTimes,
      notes: merged.modelDataScope.notes,
      feishuContent: merged.modelDataScope.feishuContent,
      attachmentText: merged.modelDataScope.attachmentText,
      chatHistory: merged.modelDataScope.chatHistory,
    },
    persona: {
      preset: merged.persona.preset,
      name: merged.persona.name,
      userName: merged.persona.userName,
      responseLength: merged.persona.responseLength,
      proactiveLevel: merged.persona.proactiveLevel,
      reminderStrength: merged.persona.reminderStrength,
    },
    permissionMode: merged.permissionMode,
    onboardingComplete: merged.onboardingComplete,
  };
}

export class SettingsService {
  readonly #settingsPath: string;
  readonly #secretsPath: string;
  readonly #encryption: EncryptionAdapter;
  #settings: AppSettings = clone(defaultSettings);
  #secrets: StoredSecrets = { schemaVersion: 1, credentials: [] };
  #settingsWriteQueue: Promise<void> = Promise.resolve();
  #secretsWriteQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, encryption: EncryptionAdapter) {
    this.#settingsPath = path.join(userDataPath, 'settings.v1.json');
    this.#secretsPath = path.join(userDataPath, 'private', 'credentials.v1.json');
    this.#encryption = encryption;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.#settingsPath, 'utf8')) as Partial<AppSettings>;
      this.#settings = mergeSettings(raw);
      if (
        raw.floating?.topMode !== this.#settings.floating.topMode ||
        raw.ai?.authMode !== this.#settings.ai.authMode ||
        raw.ai?.routing !== this.#settings.ai.routing ||
        raw.ai?.pricing === undefined ||
        raw.ai?.fallback === undefined ||
        raw.ai?.fallback?.pricing === undefined ||
        raw.notifications?.dailyTaskReminderLimit !== this.#settings.notifications.dailyTaskReminderLimit ||
        raw.notifications?.taskIgnoreBackoffEnabled !== this.#settings.notifications.taskIgnoreBackoffEnabled ||
        raw.notifications?.taskReminderMinIntervalMinutes !== this.#settings.notifications.taskReminderMinIntervalMinutes ||
        JSON.stringify(raw.notifications?.taskReminderSourceMode) !== JSON.stringify(this.#settings.notifications.taskReminderSourceMode) ||
        JSON.stringify(raw.notifications?.taskReminderProjectMode) !== JSON.stringify(this.#settings.notifications.taskReminderProjectMode) ||
        raw.pet?.proactiveDailyLimit !== this.#settings.pet.proactiveDailyLimit ||
        raw.floating?.selectedTab !== this.#settings.floating.selectedTab ||
        raw.floating?.scalePercent !== this.#settings.floating.scalePercent ||
        raw.focus === undefined ||
        raw.weather === undefined ||
        raw.pet === undefined ||
        Object.prototype.hasOwnProperty.call(raw.floating ?? {}, 'shape')
      ) {
        await this.saveSettings();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.saveSettings();
    }

    try {
      const raw = JSON.parse(await fs.readFile(this.#secretsPath, 'utf8')) as StoredSecrets;
      this.#secrets = raw.schemaVersion === 1 && Array.isArray(raw.credentials)
        ? raw
        : { schemaVersion: 1, credentials: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(): AppSettings {
    return clone(this.#settings);
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.#settings = mergeSettings({ ...this.#settings, ...patch });
    await this.saveSettings();
    return this.get();
  }

  async replace(settings: AppSettings): Promise<AppSettings> {
    this.#settings = mergeSettings(settings);
    await this.saveSettings();
    return this.get();
  }

  async saveSettings(): Promise<void> {
    const snapshot = clone(this.#settings);
    const write = this.#settingsWriteQueue.then(() =>
      atomicJsonWrite(this.#settingsPath, snapshot),
    );
    this.#settingsWriteQueue = write.catch(() => undefined);
    await write;
  }

  listCredentials(): PublicCredentialState[] {
    return this.#secrets.credentials.map(({ encryptedValue: _encryptedValue, ...credential }) => ({ ...credential }));
  }

  async setCredential(
    kind: PublicCredentialState['kind'],
    value: string,
    id: string = randomUUID(),
  ): Promise<PublicCredentialState> {
    if (!this.#encryption.isAvailable()) {
      throw new Error('SECURE_STORAGE_UNAVAILABLE');
    }
    if (!value.trim()) throw new Error('EMPTY_CREDENTIAL');

    const now = new Date().toISOString();
    const existing = this.#secrets.credentials.find((credential) => credential.id === id);
    const credential: StoredCredential = {
      id,
      kind,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      encryptedValue: this.#encryption.encryptString(value).toString('base64'),
    };
    this.#secrets.credentials = [
      ...this.#secrets.credentials.filter((item) => item.id !== id),
      credential,
    ];
    await this.#saveSecrets();
    const { encryptedValue: _encryptedValue, ...publicState } = credential;
    return publicState;
  }

  getCredential(id: string): string | undefined {
    if (!this.#encryption.isAvailable()) return undefined;
    const credential = this.#secrets.credentials.find((item) => item.id === id);
    if (!credential) return undefined;
    return this.#encryption.decryptString(Buffer.from(credential.encryptedValue, 'base64'));
  }

  async deleteCredential(id: string): Promise<boolean> {
    const next = this.#secrets.credentials.filter((credential) => credential.id !== id);
    if (next.length === this.#secrets.credentials.length) return false;
    this.#secrets.credentials = next;
    await this.#saveSecrets();
    return true;
  }

  async #saveSecrets(): Promise<void> {
    const snapshot = clone(this.#secrets);
    const write = this.#secretsWriteQueue.then(() =>
      atomicJsonWrite(this.#secretsPath, snapshot),
    );
    this.#secretsWriteQueue = write.catch(() => undefined);
    await write;
  }
}
