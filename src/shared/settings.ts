export type ThemePreference = 'system' | 'light' | 'dark';
export type FloatingTopMode = 'always' | 'focus-only' | 'never';
export type PetTab = 'all' | 'today' | 'focus' | 'chat' | 'home';
/** How the OpenAI-compatible model endpoint authenticates requests. */
export type AiAuthenticationMode = 'bearer' | 'none';
export const FLOATING_HOVER_EXPAND_DELAY_MIN_MS = 200;
export const FLOATING_HOVER_EXPAND_DELAY_MAX_MS = 5_000;
export const FLOATING_HOVER_EXPAND_DELAY_DEFAULT_MS = 1_000;
export type AgentPermissionMode = 'read-only' | 'standard' | 'full-access';
export type PersonaPreset = 'minimal' | 'warm' | 'calm' | 'strict';
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
}

export interface FocusSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  cycles: number;
  autoStartBreak: boolean;
  autoStartNextRound: boolean;
  environmentSound: 'off' | 'rain' | 'forest' | 'cafe' | 'white-noise';
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
  wellbeingReminders: boolean;
  autoDiary: boolean;
  relationshipMemory: boolean;
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
  timeoutMs: number;
  retries: number;
  dailyTokenLimit: number;
  dailyCostLimit: number;
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
  },
  focus: {
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    cycles: 4,
    autoStartBreak: false,
    autoStartNextRound: false,
    environmentSound: 'off',
  },
  weather: {
    enabled: false,
    city: '',
    cacheMinutes: 45,
  },
  pet: {
    interactionsEnabled: true,
    proactiveMessages: true,
    wellbeingReminders: true,
    autoDiary: true,
    relationshipMemory: false,
  },
  ai: {
    enabled: false,
    endpoint: 'https://api.openai.com/v1',
    model: '',
    authMode: 'bearer',
    timeoutMs: 30_000,
    retries: 1,
    dailyTokenLimit: 100_000,
    dailyCostLimit: 5,
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
