import { useEffect, useState } from 'react';
import type { AppSettings } from '../shared/settings';

/** A live, read-only view of the existing Agent settings; no separate pet config/cache. */
export function useAgentSettings() {
  const [settings, setSettings] = useState<AppSettings>();
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    const api = window.desktopApi;
    if (!api) return;
    let disposed = false;
    let receivedChange = false;
    const unsubscribe = api.events.onSettingsChanged(next => {
      if (disposed) return;
      receivedChange = true;
      setSettings(next);
      setLoadError(false);
    });
    void api.settings.get().then(initial => {
      // A slow initial read must not overwrite a newer cross-window change.
      if (!disposed && !receivedChange) setSettings(initial);
    }).catch(() => {
      if (!disposed && !receivedChange) setLoadError(true);
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  return { settings, loadError };
}
