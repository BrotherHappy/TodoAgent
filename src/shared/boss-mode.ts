import type { AppSettings } from "./settings";

/**
 * Apply the reversible desktop "Boss Mode" projection.
 *
 * Boss Mode is intentionally a settings projection rather than a second
 * persisted mode: the existing meeting-mode suppression remains the source
 * of truth for proactive messages, while the floating window is hidden in
 * the same atomic settings write. Disabling it restores the pet so the tray
 * action is a reliable escape hatch.
 */
export function withBossMode(
  settings: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...settings,
    floating: {
      ...settings.floating,
      enabled: !enabled,
    },
    pet: {
      ...settings.pet,
      meetingMode: enabled,
    },
  };
}
