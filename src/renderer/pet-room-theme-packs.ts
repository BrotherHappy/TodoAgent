import { useCallback, useEffect, useState } from "react";

export const PET_ROOM_THEME_PACKS_STORAGE_KEY = "todo-agent.pet-room-theme-packs.v1";
export const PET_ROOM_THEME_PACK_ACTIVE_KEY = "todo-agent.pet-room-theme-pack-active.v1";
export const PET_ROOM_THEME_PACKS_CHANGED_EVENT = "todo-agent-pet-room-theme-packs-changed";

export interface PetRoomThemeColors {
  top: string;
  ground: string;
  window: string;
  accent: string;
}

export interface InstalledPetRoomThemePack {
  id: string;
  name: string;
  description: string;
  colors: PetRoomThemeColors;
  installedAt: string;
}

export type PetRoomThemePackImportResult =
  | { ok: true; pack: InstalledPetRoomThemePack }
  | { ok: false; message: string };

const colorPattern = /^#[0-9a-f]{6}$/iu;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const storageOf = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

const clonePack = (pack: InstalledPetRoomThemePack): InstalledPetRoomThemePack => ({
  ...pack,
  colors: { ...pack.colors },
});

const emitChanged = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PET_ROOM_THEME_PACKS_CHANGED_EVENT));
};

export const validatePetRoomThemePack = (value: unknown): PetRoomThemePackImportResult => {
  if (!isRecord(value)) return { ok: false, message: "颜色主题需要是一个 JSON 对象。" };
  const allowedKeys = new Set(["id", "name", "description", "colors", "installedAt"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return { ok: false, message: "主题包只允许包含名称、说明和四种颜色，不接受脚本、路径或 CSS。" };
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/u.test(id)) {
    return { ok: false, message: "主题包 ID 只能使用 2–40 位小写字母、数字和短横线。" };
  }
  if (name.length < 1 || name.length > 40) {
    return { ok: false, message: "主题名称需要在 1–40 个字符之间。" };
  }
  if (description.length > 160) {
    return { ok: false, message: "主题说明不能超过 160 个字符。" };
  }
  if (!isRecord(value.colors)) return { ok: false, message: "主题需要提供顶部、地面、窗户和强调色。" };
  const colors = value.colors;
  const colorKeys = ["top", "ground", "window", "accent"] as const;
  if (Object.keys(colors).some((key) => !colorKeys.includes(key as (typeof colorKeys)[number]))) {
    return { ok: false, message: "主题颜色只允许 top、ground、window、accent 四项。" };
  }
  const normalizedColors: PetRoomThemeColors = {
    top: typeof colors.top === "string" ? colors.top.trim().toLowerCase() : "",
    ground: typeof colors.ground === "string" ? colors.ground.trim().toLowerCase() : "",
    window: typeof colors.window === "string" ? colors.window.trim().toLowerCase() : "",
    accent: typeof colors.accent === "string" ? colors.accent.trim().toLowerCase() : "",
  };
  if (colorKeys.some((key) => !colorPattern.test(normalizedColors[key]))) {
    return { ok: false, message: "颜色必须是六位十六进制色值，例如 #cfd8ff。" };
  }
  return {
    ok: true,
    pack: {
      id,
      name,
      description,
      colors: normalizedColors,
      installedAt: new Date().toISOString(),
    },
  };
};

export const parsePetRoomThemePackJson = (raw: string): PetRoomThemePackImportResult => {
  try {
    return validatePetRoomThemePack(JSON.parse(raw));
  } catch {
    return { ok: false, message: "主题包不是有效的 JSON。" };
  }
};

export const loadInstalledPetRoomThemePacks = (
  storage: Pick<Storage, "getItem"> | undefined = storageOf(),
): InstalledPetRoomThemePack[] => {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PET_ROOM_THEME_PACKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => validatePetRoomThemePack(item))
      .filter((result): result is { ok: true; pack: InstalledPetRoomThemePack } => result.ok)
      .map((result) => clonePack(result.pack));
  } catch {
    return [];
  }
};

const writeInstalledPetRoomThemePacks = (
  packs: readonly InstalledPetRoomThemePack[],
  storage: Pick<Storage, "setItem"> | undefined = storageOf(),
): void => {
  if (!storage) return;
  storage.setItem(PET_ROOM_THEME_PACKS_STORAGE_KEY, JSON.stringify(packs));
  emitChanged();
};

export const installPetRoomThemePack = (
  pack: InstalledPetRoomThemePack,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = storageOf(),
): InstalledPetRoomThemePack[] => {
  const current = loadInstalledPetRoomThemePacks(storage);
  const validated = validatePetRoomThemePack(pack);
  if (!validated.ok) return current;
  const next = [...current.filter((item) => item.id !== validated.pack.id), clonePack(validated.pack)].slice(-12);
  writeInstalledPetRoomThemePacks(next, storage);
  return next;
};

export const removePetRoomThemePack = (
  id: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = storageOf(),
): InstalledPetRoomThemePack[] => {
  const next = loadInstalledPetRoomThemePacks(storage).filter((item) => item.id !== id);
  writeInstalledPetRoomThemePacks(next, storage);
  if (storage?.getItem(PET_ROOM_THEME_PACK_ACTIVE_KEY) === id) {
    storage.removeItem(PET_ROOM_THEME_PACK_ACTIVE_KEY);
    emitChanged();
  }
  return next;
};

export const getActivePetRoomThemePackId = (
  storage: Pick<Storage, "getItem"> | undefined = storageOf(),
): string | undefined => {
  const value = storage?.getItem(PET_ROOM_THEME_PACK_ACTIVE_KEY)?.trim();
  return value || undefined;
};

export const setActivePetRoomThemePackId = (
  id: string | undefined,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = storageOf(),
): void => {
  if (!storage) return;
  if (id) storage.setItem(PET_ROOM_THEME_PACK_ACTIVE_KEY, id);
  else storage.removeItem(PET_ROOM_THEME_PACK_ACTIVE_KEY);
  emitChanged();
};

export function useInstalledPetRoomThemePacks(): {
  packs: InstalledPetRoomThemePack[];
  activeId?: string;
  activePack?: InstalledPetRoomThemePack;
  install: (pack: InstalledPetRoomThemePack) => void;
  remove: (id: string) => void;
  activate: (id?: string) => void;
} {
  const [packs, setPacks] = useState<InstalledPetRoomThemePack[]>(() => loadInstalledPetRoomThemePacks());
  const [activeId, setActiveId] = useState<string | undefined>(() => getActivePetRoomThemePackId());
  useEffect(() => {
    const refresh = () => {
      setPacks(loadInstalledPetRoomThemePacks());
      setActiveId(getActivePetRoomThemePackId());
    };
    window.addEventListener(PET_ROOM_THEME_PACKS_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(PET_ROOM_THEME_PACKS_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  const install = useCallback((pack: InstalledPetRoomThemePack) => {
    installPetRoomThemePack(pack);
    setPacks(loadInstalledPetRoomThemePacks());
  }, []);
  const remove = useCallback((id: string) => {
    removePetRoomThemePack(id);
    setPacks(loadInstalledPetRoomThemePacks());
    setActiveId(getActivePetRoomThemePackId());
  }, []);
  const activate = useCallback((id?: string) => {
    setActivePetRoomThemePackId(id);
    setActiveId(id);
  }, []);
  return { packs, activeId, activePack: packs.find((pack) => pack.id === activeId), install, remove, activate };
}
