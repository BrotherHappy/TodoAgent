import type { FocusShieldMode } from '../shared/settings';

const MAX_APPLICATIONS = 12;
const MAX_APPLICATION_NAME_LENGTH = 80;

/** Keep the setting small and predictable: this is a user-maintained list,
 * not a process inventory. Display casing is preserved while matching is
 * case-insensitive. */
export const normalizeShieldApplications = (values: readonly unknown[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().slice(0, MAX_APPLICATION_NAME_LENGTH);
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
    if (normalized.length >= MAX_APPLICATIONS) break;
  }
  return normalized;
};

/** Return the configured label that matched, or undefined when no app is watched. */
export const matchesShieldApplication = (
  appName: string,
  applications: readonly string[],
): string | undefined => {
  const normalizedApp = appName.trim().toLocaleLowerCase();
  if (!normalizedApp) return undefined;
  return applications.find((application) => {
    const normalized = application.trim().toLocaleLowerCase();
    return normalized.length > 0 && normalizedApp.includes(normalized);
  });
};

export const focusShieldModeLabel = (mode: FocusShieldMode): string => {
  switch (mode) {
    case 'gentle':
      return '温和提醒';
    case 'pause':
      return '匹配时自动暂停';
    case 'off':
    default:
      return '关闭';
  }
};

export const FOCUS_SHIELD_POLL_INTERVAL_MS = 8_000;
export const FOCUS_SHIELD_DISMISS_MS = 10 * 60_000;

