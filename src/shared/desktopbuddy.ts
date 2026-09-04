// Adapted from DesktopBuddy (DCDingCong), MIT. See assets/desktopbuddy/licenses/DesktopBuddy-LICENSE.
export type PetBehavior =
  | 'idleMotion'
  | 'attention'
  | 'touchReaction'
  | 'dragReaction'
  | 'dropReaction'
  | 'lifeRoutine'
  | 'optionalCare'
  | 'aiThinking'
  | 'aiSpeaking'
  | 'aiNeedConfirm'
  | 'aiSuccess'
  | 'aiError'
  | 'pluginNotify';

export type PetVisualState = 'idle' | 'attentive' | 'happy' | 'sleepy' | 'dragging' | 'sleeping';
export type PetNotificationKind = 'ai' | 'routine' | 'reminder' | 'plugin' | 'tool' | 'system';
export type PetNotificationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type GlobalShortcutAction = 'quickMenu' | 'aiChat' | 'togglePet';
export type AiPersonaPreset = 'gentle' | 'witty' | 'quiet' | 'efficient';

export interface PetBehaviorIntent {
  behavior: PetBehavior;
  variant?: string;
  mood?: string;
  intensity?: 'low' | 'normal' | 'high';
  ttlMs?: number;
  message?: string;
}

export interface PetResolvedBehavior {
  themeId: string;
  renderer: PetThemeRenderer;
  motion?: string;
  expression?: string;
  fallbackMotion?: string;
  missingMotion: boolean;
}

export interface PetStats {
  mood: number;
  energy: number;
  hunger: number;
  intimacy: number;
  behavior: PetBehaviorIntent;
  resolvedBehavior: PetResolvedBehavior;
  visualState: PetVisualState;
  message: string;
  attentionActive?: boolean;
  attentionPoint?: PetAttentionPoint;
  routineSegment?: string;
  lastInteractionAt?: number;
  lastRoutineAt?: number;
  statusText?: string;
  relationshipLevel?: 'new' | 'familiar' | 'close';
  notificationQueueLength?: number;
}

export type PetAction = 'pet' | 'feed' | 'play' | 'sleep-toggle' | 'wake' | 'drag-start' | 'drag-end';
export type PetRuntimeEventType =
  | PetAction
  | 'attention-enter'
  | 'attention-move'
  | 'attention-leave'
  | 'routine-trigger'
  | 'interaction-trigger';

export interface PetAttentionPoint {
  x: number;
  y: number;
}

export interface PetRuntimeEventPayload {
  x?: number;
  y?: number;
  segmentId?: string;
  behaviorRef?: string;
  message?: string;
  now?: number;
  kind?: string;
}

export interface PetRuntimeEvent {
  type: PetRuntimeEventType;
  payload?: PetRuntimeEventPayload;
}

export interface PetSettings {
  size: number;
  opacity: number;
  pet: string;
  routineEnabled: boolean;
  routineIntensity: 'quiet' | 'standard' | 'active';
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  bubbleEnabled: boolean;
  launchAtLogin: boolean;
  clickThrough: boolean;
  edgeSnapEnabled: boolean;
  edgeSnapThreshold: number;
  displayMode: 'primary' | 'current' | 'remembered';
  globalShortcutEnabled: boolean;
  globalShortcut: string;
  globalShortcutAction: GlobalShortcutAction;
  diagnosticsEnabled: boolean;
}

export interface PetNotificationItem {
  id: string;
  kind: PetNotificationKind;
  priority: PetNotificationPriority;
  behavior: PetBehaviorIntent;
  message: string;
  createdAt: number;
  ttlMs: number;
  dedupeKey?: string;
}

export interface NotificationHistoryEntry {
  id: string;
  kind: PetNotificationKind;
  priority: PetNotificationPriority;
  message: string;
  createdAt: string;
  firedAt: string;
}

export type PetThemeType = 'animal' | 'human' | 'plant' | 'objectSpirit' | 'abstract';
export type PetThemeRenderer = 'live2d' | 'staticImage';

export interface PetThemeLayout {
  defaultSize: number;
  minSize: number;
  maxSize: number;
  anchor: 'bottomCenter' | 'center' | 'bottomLeft' | 'bottomRight';
  preferredDock: 'bottomRight' | 'bottomLeft' | 'free';
  fitPadding?: number;
  offsetX?: number;
  offsetY?: number;
  hitAreaScale?: number;
}

export interface PetThemeColors {
  swatches: [string, string, string];
  cssClass: string;
}

export interface PetThemeModel {
  model3?: string;
  core?: string;
  preview?: string;
  staticImages?: Record<string, string>;
  defaultImage?: string;
}

export interface PetThemeSource {
  type: 'official-sample' | 'open-source' | 'local';
  url?: string;
  license?: string;
}

export interface PetThemeCapabilities {
  idleMotion: boolean;
  attention: boolean;
  touchReaction: boolean;
  dragReaction: boolean;
  lifeRoutine: boolean;
  ambientMood: boolean;
  optionalCare: string[];
  aiExpression: boolean;
  lookAtCursor: boolean;
  audioFeedback: boolean;
}

export type PetMotionMappingValue = string | string[] | Record<string, string | string[]>;

export interface PetThemeInteraction {
  id: string;
  label: string;
  behavior: string;
  cooldownMs?: number;
}

export interface PetThemeFallback {
  renderer: PetThemeRenderer;
  motion: Record<string, string>;
}

export interface PetThemeRoutineSegment {
  id: string;
  behavior: string;
  from?: string;
  to?: string;
  when?: 'timeRange' | 'userActiveLong' | 'noInteraction' | 'quietHours';
  afterMs?: number;
  minQuietMs?: number;
  cooldownMs?: number;
  weight?: number;
  message?: string;
  mood?: string;
}

export interface PetThemeRoutine {
  timezoneMode: 'system';
  segments: PetThemeRoutineSegment[];
}

export interface PetThemeManifest {
  schemaVersion: number;
  id: string;
  displayName: string;
  version: string;
  author?: string;
  type: PetThemeType;
  renderer: PetThemeRenderer;
  description?: string;
  source?: PetThemeSource;
  layout: PetThemeLayout;
  model?: PetThemeModel;
  colors: PetThemeColors;
  capabilities: PetThemeCapabilities;
  motions: Record<string, PetMotionMappingValue>;
  expressions?: Record<string, string>;
  interactions: PetThemeInteraction[];
  routine?: PetThemeRoutine;
  fallback: PetThemeFallback;
}

export interface PetThemeSummary {
  id: string;
  displayName: string;
  type: PetThemeType;
  renderer: PetThemeRenderer;
  origin?: 'builtin' | 'user';
  enabled?: boolean;
  importedAt?: string;
  themeDir?: string;
  description?: string;
  source?: PetThemeSource;
  model?: PetThemeModel;
  colors: PetThemeColors;
  capabilities: PetThemeCapabilities;
  interactions: PetThemeInteraction[];
  routine?: PetThemeRoutine;
  health?: PetThemeHealthSummary;
}

export interface PetThemeImportResult {
  ok: boolean;
  themeId?: string;
  summary?: PetThemeSummary;
  validation: PetThemeValidationResult;
  importPath?: string;
  issues: PetThemeValidationIssue[];
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  electronVersion: string;
  platform: string;
  userDataPath: string;
  currentThemeId: string;
  currentThemeHealth?: PetThemeHealthSummary;
  windowBounds?: { x: number; y: number; width: number; height: number };
  displays: Array<{
    id: number;
    scaleFactor: number;
    bounds: { x: number; y: number; width: number; height: number };
    workArea: { x: number; y: number; width: number; height: number };
  }>;
  settings: PetSettings;
  globalShortcutRegistered: boolean;
  eventApi?: {
    enabled: boolean;
    port?: number;
  };
  notificationQueueLength?: number;
  notificationHistoryCount?: number;
  recentRendererErrors: string[];
  checkedAt: string;
}

export interface Live2DSpikeAssets {
  assetDir: string;
  coreUrl: string;
  modelUrl: string;
  coreExists: boolean;
  modelExists: boolean;
}

export interface PetThemeRuntimeAssets {
  themeId: string;
  renderer: PetThemeRenderer;
  assetDir: string;
  coreUrl?: string;
  modelUrl?: string;
  coreExists: boolean;
  modelExists: boolean;
  staticImageUrl?: string;
  staticImages?: Record<string, string>;
  layout?: PetThemeLayout;
}

export type PetThemeHealthStatus =
  | 'ready'
  | 'not-required'
  | 'missing-assets'
  | 'invalid-manifest'
  | 'invalid-motion'
  | 'renderer-error';

export type PetThemeValidationSeverity = 'info' | 'warning' | 'error';

export interface PetThemeValidationIssue {
  severity: PetThemeValidationSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface PetThemeHealthSummary {
  status: PetThemeHealthStatus;
  ready: boolean;
  issueCount: number;
  errorCount: number;
}

export interface PetThemeValidationResult {
  themeId: string;
  renderer: PetThemeRenderer;
  status: PetThemeHealthStatus;
  ready: boolean;
  issues: PetThemeValidationIssue[];
  assets?: PetThemeRuntimeAssets;
  availableMotions: string[];
  availableExpressions: string[];
  checkedAt: string;
}

export type AiProviderKind = 'disabled' | 'mockEcho' | 'openaiCompatible' | 'ollama';
export type AiRuntimeStatus = 'idle' | 'needsConfig' | 'thinking' | 'speaking' | 'success' | 'error' | 'cancelled';
export type AiConversationRole = 'user' | 'assistant' | 'system';
export type AiCredentialState = 'none' | 'encrypted' | 'unsupported' | 'legacyPlaintext';

export interface AiPermissionState {
  screen: 'off' | 'selectedRegionOnce';
  files: 'off' | 'selectedFileOnce';
  clipboard: 'off';
  tools: 'off' | 'confirmEach';
}

// Do not port DesktopBuddy's independent AiProviderConfig. All model connections
// and credentials are owned by TodoAgent's AppSettings.ai / SettingsService.

export interface AiConversationMessage {
  id: string;
  role: AiConversationRole;
  content: string;
  createdAt: string;
  status?: 'sending' | 'streaming' | 'done' | 'error' | 'cancelled';
  error?: string;
  toolCall?: AiToolCallRequest;
}

export interface AiRequestContext {
  time: string;
  locale: string;
  platform: string;
  appVersion: string;
  pet: {
    themeId: string;
    type?: PetThemeType;
    currentBehavior: PetBehavior;
    currentVariant?: string;
    mood: number;
    energy: number;
    intimacy: number;
    routineSegment?: string;
    relationshipLevel?: PetStats['relationshipLevel'];
  };
  recentInteractions: Array<{
    behavior: PetBehavior;
    variant?: string;
    at?: number;
  }>;
  permissions: AiPermissionState;
  personaPreset: AiPersonaPreset;
  activeWindow?: {
    appName?: string;
    processName?: string;
    title?: string;
    friendlyName?: string;
    fileName?: string;
  };
  memory: {
    enabled: boolean;
    summary?: string;
  };
}

export interface AiRuntimeState {
  enabled: boolean;
  provider: AiProviderKind;
  configured: boolean;
  status: AiRuntimeStatus;
  lastError?: string;
  lastMessageAt?: string;
  activeRequestId?: string;
  conversationCount: number;
  memoryEnabled: boolean;
  permissions: AiPermissionState;
}

export interface AiSendMessageInput {
  content: string;
}

export interface AiToolPlan {
  tool: 'createReminder' | 'startTimer' | 'createTodoDraft';
  confidence: number;
  reason: string;
  args: Record<string, unknown>;
  confirmationText: string;
}

export interface AiToolCallRequest {
  id: string;
  tool: string;
  risk: 'low' | 'medium' | 'high' | 'blocked';
  reason: string;
  argsPreview: Record<string, unknown>;
  requiresConfirm: boolean;
}

export type AiPermissionRequestKind = 'screen.selectedRegionOnce' | 'files.selectedFileOnce' | 'tools.confirmEach';
export type AiDecision = 'approved' | 'denied';

export interface AiPermissionRequest {
  kind: AiPermissionRequestKind;
  title: string;
  reason: string;
  dataPreview?: string;
}

export interface AiPermissionRecord {
  id: string;
  kind: AiPermissionRequestKind;
  title: string;
  reason: string;
  decision: AiDecision;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  scopeAlias?: string;
  dataKind?: 'screen' | 'file' | 'tool';
}

export interface AiToolCallRecord {
  id: string;
  tool: string;
  risk: AiToolCallRequest['risk'];
  reason: string;
  decision: AiDecision;
  argsPreview: Record<string, unknown>;
  createdAt: string;
}

export interface AiValidationRecord {
  id: string;
  provider: AiProviderKind;
  model: string;
  kind: 'text' | 'vision';
  ok: boolean;
  message: string;
  createdAt: string;
}

export interface AiScreenRegionContext {
  width: number;
  height: number;
  imageDataUrl: string;
  permissionRecordId: string;
}

export interface AiFileContext {
  alias: string;
  type: string;
  size: number;
  contentPreview: string;
  permissionRecordId: string;
}

export interface AiReminderDraft {
  title: string;
  afterMinutes: number;
}

export interface AiReminderItem {
  id: string;
  title: string;
  dueAt: string;
  createdAt: string;
  status: 'pending' | 'fired' | 'cancelled';
  source: 'manual' | 'aiTool';
}

export interface AiTodoDraft {
  id: string;
  title: string;
  createdAt: string;
  source: 'aiTool';
}

export interface AiMemoryItem {
  id: string;
  type: 'preference' | 'routine' | 'relationship' | 'task';
  content: string;
  source: 'explicit_user' | 'manual';
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiMemoryDraft {
  type: AiMemoryItem['type'];
  content: string;
}

export type LocalEventKind = 'notify' | 'taskStart' | 'taskSuccess' | 'taskError' | 'waitingUser';

export interface LocalEventRequest {
  kind: LocalEventKind;
  message: string;
  title?: string;
  source?: string;
}

export interface LocalEventResponse {
  ok: boolean;
  id?: string;
  message: string;
}
