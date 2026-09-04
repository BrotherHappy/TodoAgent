import { useSyncExternalStore } from 'react';
import type { BuddyAssets, BuddySnapshot } from '../../shared/desktopbuddy-contract';

let snapshot: BuddySnapshot | null = null;
let starting = false;
const listeners = new Set<() => void>();
const assets = new Map<string, Promise<BuddyAssets>>();
export function acceptBuddySnapshot(next: BuddySnapshot): void {
  snapshot = next;
  listeners.forEach(listener => listener());
}
function start(): void {
  if (starting || !window.desktopApi?.buddy) return;
  starting = true;
  const api = window.desktopApi.buddy;
  api.onChange(next => { assets.clear(); acceptBuddySnapshot(next); });
  void api.snapshot().then(acceptBuddySnapshot).catch(() => { starting = false; });
}
export function useBuddySnapshot(): BuddySnapshot | null {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    start();
    return () => listeners.delete(listener);
  }, () => snapshot, () => null);
}
export function loadBuddyAssets(id: string): Promise<BuddyAssets> {
  let pending = assets.get(id);
  if (!pending) {
    pending = window.desktopApi!.buddy!.assets(id).catch(error => { assets.delete(id); throw error; });
    assets.set(id, pending);
  }
  return pending;
}
