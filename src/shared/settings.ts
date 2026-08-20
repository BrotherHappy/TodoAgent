import type { ModelPricing } from './agent-types';

export type ThemePreference = 'system' | 'light' | 'dark';
export type FloatingTopMode = 'always' | 'focus-only' | 'never';
export type PetTab = 'all' | 'today' | 'focus' | 'chat' | 'home';
/** How the OpenAI-compatible model endpoint authenticates requests. */
export type AiAuthenticationMode = 'bearer' | 'none';
/** How Agent chooses between the primary and optional local model. */
export type AiRoutingMode = 'primary-only' | 'fallback-on-error' | 'local-only';
export const FLOATING_HOVER_EXPAND_DELAY_MIN_MS = 200;
export const FLOATING_HOVER_EXPAND_DELAY_MAX_MS = 5_000;
export const FLOATING_HOVER_EXPAND_DELAY_DEFAULT_MS = 1_000;
export type AgentPermissionMode = 'read-only' | 'standard' | 'full-access';
export type PersonaPreset = 'minimal' | 'warm' | 'calm' | 'strict';
export type TaskReminderSourceMode = 'normal' | 'important-only' | 'off';
export type FeishuConnectionMode =
  | 'personal-direct'
  | 'existing-direct'
  | 'relay'
  | 'local-development';

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
  banners: boolean;
  badge: boolean;
  morningBrief: boolean;
  morningBriefTime: string;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  /** Maximum number of task reminder banners per local day; 0 means unlimited. */
  dailyTaskReminderLimit: number;
  /** After repeated dismissal of one task reminder, stop resurfacing that reminder. */
  taskIgnoreBackoffEnabled: boolean;
  /** Minimum gap between different ordinary task reminders; 0 disables the gap. */
  taskReminderMinIntervalMinutes: number;
  /** Source-specific policy for local and Feishu task reminders. */
  taskReminderSourceMode: {
    local: TaskReminderSourceMode;
    feishu: TaskReminderSourceMode;
  };
  /** Optional project-specific overrides; project ID is the task model's projectId. */
  taskReminderProjectMode: Record<string, TaskReminderSourceMode>;
  mutedUntil?: string;
}

export interface FloatingSettings {
  enabled: boolean;
  hoverExpandDelayMs: number;
  topMode: FloatingTopMode;
  locked: boolean;
  hideInFullscreen: boolean;
  privacyMode: boolean;
  selectedTab: PetTab;
  scalePercent: number;
  /** The most recently used display, so multi-monitor positions survive restart. */
  lastDisplayId?: string;
  positions: Record<string, { x: number; y: number }>;
  /** Keep the pet visible while allowing clicks to pass through to other apps. */
  mousePassthrough: boolean;
}

export interface FocusSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  cycles: number;
  autoStartBreak: boolean;
  autoStartNextRound: boolean;
  environmentSound: 'off' | 'rain' | 'forest' | 'cafe' | 'white-noise';
  /** Optional, local-only protection against opening distracting apps while focusing. */
  shieldMode: FocusShieldMode;
  /** App-name fragments to watch while a focus session is running. */
  shieldApplications: string[];
}

/** How the pet reacts when a watched app becomes the frontmost application. */
export type FocusShieldMode = 'off' | 'gentle' | 'pause';

/**
 * Transparent, local-only weights used when the pet chooses a next task.
 * They are deliberately bounded rather than exposing an opaque AI score.
 */
export interface TaskUrgencyWeights {
  deadline: number;
  plannedToday: number;
  priority: number;
  quickWin: number;
}

export interface PlanningSettings {
  urgencyWeights: TaskUrgencyWeights;
}

export interface WeatherSettings {
  enabled: boolean;
  city: string;
  latitude?: number;
  longitude?: number;
  resolvedName?: string;
  cacheMinutes: number;
}

export interface PetBehaviorSettings {
  interactionsEnabled: boolean;
  proactiveMessages: boolean;
  /** Derive a coarse typing/reading posture from system idle time; off by default. */
  inputReactionsEnabled: boolean;
  /** Pause proactive companion behavior without hiding the pet or changing tasks. */
  vacationMode: boolean;
  wellbeingReminders: boolean;
  autoDiary: boolean;
  relationshipMemory: boolean;
  actionPack: 'balanced' | 'calm' | 'playful' | 'focused';
  animationIntensity: 'gentle' | 'lively';
  proactiveIntervalMinutes: number;
  /** Maximum proactive companion messages per local day; 0 means unlimited. */
  proactiveDailyLimit: number;
  meetingMode: boolean;
  seasonalEvents: boolean;
}

export interface AiProviderSettings {
  enabled: boolean;
  endpoint: string;
  model: string;
  /**
   * `none` is an explicit opt-in for a trusted self-hosted endpoint that
   * does not use an API key. It never causes an empty Authorization header to
   * be sent.
  */
  authMode: AiAuthenticationMode;
  /** Use the local provider only when the primary provider has a retryable failure. */
  routing: AiRoutingMode;
  /** Optional OpenAI-compatible local/self-hosted provider. Disabled by default. */
  fallback: AiFallbackProviderSettings;
  timeoutMs: number;
  retries: number;
  dailyTokenLimit: number;
  dailyCostLimit: number;
  /** Optional user-entered prices used only for local cost accounting. */
  pricing: ModelPricing;
  credentialId?: string;
}

export interface AiFallbackProviderSettings {
  enabled: boolean;
  endpoint: string;
  model: string;
  authMode: AiAuthenticationMode;
  /** Optional local-model prices used only for local cost accounting. */
  pricing: ModelPricing;
  credentialId?: string;
}

export interface ModelDataScope {
  taskTitlesAndTimes: boolean;
  notes: boolean;
  feishuContent: boolean;
  attachmentText: boolean;
  chatHistory: boolean;
}

export interface PersonaSettings {
  preset: PersonaPreset;
  name: string;
  userName: string;
  responseLength: 'short' | 'balanced' | 'detailed';
  proactiveLevel: 'quiet' | 'balanced' | 'active';
  reminderStrength: 'gentle' | 'normal' | 'firm';
  /** Keep Agent language aligned with the live Todo Pet personality. */
  syncWithPet: boolean;
}

export interface FeishuIntegrationSettings {
  configured: boolean;
  mode: FeishuConnectionMode;
  /** Local account namespace. It is not sent to Feishu. */
  accountId: string;
  /** Stable reference to the OS-encrypted OAuth token. */
  tokenCredentialId?: string;
  relayBaseUrl: string;
  clientId: string;
  appSecretCredentialId?: string;
  acknowledgeInsecureLocalCredentials: boolean;
  autoSync: boolean;
  pollingMinutes: number;
}

export interface AppSettings {
  schemaVersion: 1;
  theme: ThemePreference;
  launchAtLogin: boolean;
  closeToTray: boolean;
  quickCaptureShortcut: string;
  notifications: NotificationSettings;
  floating: FloatingSettings;
  focus: FocusSettings;
  planning: PlanningSettings;
  weather: WeatherSettings;
  pet: PetBehaviorSettings;
  ai: AiProviderSettings;
  feishu: FeishuIntegrationSettings;
  modelDataScope: ModelDataScope;
  persona: PersonaSettings;
  permissionMode: AgentPermissionMode;
  onboardingComplete: boolean;
}

export const defaultSettings: AppSettings = {
  schemaVersion: 1,
  theme: 'system',
  launchAtLogin: false,
  closeToTray: true,
  quickCaptureShortcut: 'CommandOrControl+Shift+Space',
  notifications: {
    enabled: true,
    sound: true,
    banners: true,
    badge: true,
    morningBrief: true,
    morningBriefTime: '09:00',
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    dailyTaskReminderLimit: 8,
    taskIgnoreBackoffEnabled: true,
    taskReminderMinIntervalMinutes: 120,
    taskReminderSourceMode: {
      local: 'normal',
      feishu: 'normal',
    },
    taskReminderProjectMode: {},
  },
  floating: {
    enabled: true,
    hoverExpandDelayMs: FLOATING_HOVER_EXPAND_DELAY_DEFAULT_MS,
    topMode: 'always',
    locked: false,
    hideInFullscreen: true,
    privacyMode: false,
    selectedTab: 'all',
    scalePercent: 100,
    positions: {},
    mousePassthrough: false,
  },
  focus: {
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    cycles: 4,
    autoStartBreak: false,
    autoStartNextRound: false,
    environmentSound: 'off',
    shieldMode: 'off',
    shieldApplications: [],
  },
  planning: {
    urgencyWeights: {
      deadline: 70,
      plannedToday: 90,
      priority: 40,
      quickWin: 10,
    },
  },
  weather: {
    enabled: false,
    city: '',
    cacheMinutes: 45,
  },
  pet: {
    interactionsEnabled: true,
    proactiveMessages: true,
    inputReactionsEnabled: false,
    vacationMode: false,
    wellbeingReminders: true,
    autoDiary: true,
    relationshipMemory: false,
    actionPack: 'balanced',
    animationIntensity: 'lively',
    proactiveIntervalMinutes: 45,
    proactiveDailyLimit: 2,
    meetingMode: false,
    seasonalEvents: true,
  },
  ai: {
    enabled: false,
    endpoint: 'https://api.openai.com/v1',
    model: '',
    authMode: 'bearer',
    routing: 'primary-only',
    fallback: {
      enabled: false,
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'llama3.2',
      authMode: 'none',
      pricing: {
        promptUsdPerMillionTokens: 0,
        completionUsdPerMillionTokens: 0,
      },
    },
    timeoutMs: 30_000,
    retries: 1,
    dailyTokenLimit: 100_000,
    dailyCostLimit: 5,
    pricing: {
      promptUsdPerMillionTokens: 0,
      completionUsdPerMillionTokens: 0,
    },
  },
  feishu: {
    configured: false,
    mode: 'personal-direct',
    accountId: 'primary',
    tokenCredentialId: 'feishu-primary-token',
    relayBaseUrl: '',
    clientId: '',
    acknowledgeInsecureLocalCredentials: false,
    autoSync: true,
    pollingMinutes: 5,
  },
  modelDataScope: {
    taskTitlesAndTimes: true,
    notes: false,
    feishuContent: false,
    attachmentText: false,
    chatHistory: false,
  },
  persona: {
    preset: 'calm',
    name: '小序',
    userName: '',
    responseLength: 'balanced',
    proactiveLevel: 'balanced',
    reminderStrength: 'gentle',
    syncWithPet: true,
  },
  permissionMode: 'standard',
  onboardingComplete: false,
};

export interface PublicCredentialState {
  id: string;
  kind: 'ai-api-key' | 'feishu-app-secret' | 'feishu-token';
  createdAt: string;
  updatedAt: string;
}
