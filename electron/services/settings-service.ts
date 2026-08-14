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
    weather: { ...defaultSettings.weather, ...value?.weather },
    pet: { ...defaultSettings.pet, ...value?.pet },
    ai: { ...defaultSettings.ai, ...value?.ai },
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
  merged.focus.focusMinutes = Math.min(240, Math.max(1, Math.round(merged.focus.focusMinutes)));
  merged.focus.shortBreakMinutes = Math.min(60, Math.max(1, Math.round(merged.focus.shortBreakMinutes)));
  merged.focus.longBreakMinutes = Math.min(120, Math.max(1, Math.round(merged.focus.longBreakMinutes)));
  merged.focus.cycles = Math.min(12, Math.max(1, Math.round(merged.focus.cycles)));
  merged.weather.cacheMinutes = Math.min(120, Math.max(30, Math.round(merged.weather.cacheMinutes)));

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
    },
    ai: {
      enabled: merged.ai.enabled,
      endpoint: merged.ai.endpoint,
      model: merged.ai.model,
      authMode: merged.ai.authMode,
      timeoutMs: merged.ai.timeoutMs,
      retries: merged.ai.retries,
      dailyTokenLimit: merged.ai.dailyTokenLimit,
      dailyCostLimit: merged.ai.dailyCostLimit,
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
        raw.floating?.selectedTab !== this.#settings.floating.selectedTab ||
        raw.floating?.scalePercent !== this.#settings.floating.scalePercent ||
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
