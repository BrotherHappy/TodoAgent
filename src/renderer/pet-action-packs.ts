import { useCallback, useEffect, useState } from "react";
import {
  idlePetActions,
  type PetActionPack,
  type PetIdleAction,
} from "./pet-behavior";

export const PET_ACTION_PACKS_STORAGE_KEY = "todo-agent.pet-action-packs.v1";
export const PET_ACTION_PACK_ACTIVE_KEY = "todo-agent.pet-action-pack-active.v1";
export const PET_ACTION_PACKS_CHANGED_EVENT = "todo-agent-pet-action-packs-changed";

export interface InstalledPetActionPack {
  id: string;
  name: string;
  description: string;
  idleActions: PetIdleAction[];
  installedAt: string;
}

export type PetActionPackImportResult =
  | { ok: true; pack: InstalledPetActionPack }
  | { ok: false; message: string };

const allowedActions = new Set<PetIdleAction>(idlePetActions);
const builtInPackIds = new Set<PetActionPack>([
  "balanced",
  "calm",
  "playful",
  "focused",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const storageOf = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

const emitChanged = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PET_ACTION_PACKS_CHANGED_EVENT));
};

const clonePack = (pack: InstalledPetActionPack): InstalledPetActionPack => ({
  ...pack,
  idleActions: [...pack.idleActions],
});

export const validatePetActionPack = (value: unknown): PetActionPackImportResult => {
  if (!isRecord(value)) return { ok: false, message: "动作包必须是一个 JSON 对象。" };
  const allowedKeys = new Set(["id", "name", "description", "idleActions", "installedAt"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return { ok: false, message: "动作包只允许包含名称、说明和已有待机动作，不接受脚本或其他扩展字段。" };
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/u.test(id) || builtInPackIds.has(id as PetActionPack)) {
    return { ok: false, message: "动作包 ID 只能使用 2–40 位小写字母、数字和短横线，且不能占用内置 ID。" };
  }
  if (name.length < 1 || name.length > 40) {
    return { ok: false, message: "动作包名称需要在 1–40 个字符之间。" };
  }
  if (description.length > 160) {
    return { ok: false, message: "动作包说明不能超过 160 个字符。" };
  }
  if (!Array.isArray(value.idleActions) || value.idleActions.length < 1 || value.idleActions.length > 20) {
    return { ok: false, message: "动作包需要包含 1–20 个待机动作。" };
  }
  const idleActions = value.idleActions.filter((item): item is PetIdleAction => typeof item === "string");
  if (idleActions.length !== value.idleActions.length || idleActions.some((action) => !allowedActions.has(action))) {
    return { ok: false, message: "动作包只能组合 Todo Pet 已提供的待机动作，不支持脚本、网络或外部代码。" };
  }
  if (new Set(idleActions).size !== idleActions.length) {
    return { ok: false, message: "动作包中的待机动作不能重复。" };
  }
  return {
    ok: true,
    pack: {
      id,
      name,
      description,
      idleActions,
      installedAt: new Date().toISOString(),
    },
  };
};

export const parsePetActionPackJson = (raw: string): PetActionPackImportResult => {
  try {
    return validatePetActionPack(JSON.parse(raw));
  } catch {
    return { ok: false, message: "动作包不是有效的 JSON。" };
  }
};

export const loadInstalledPetActionPacks = (
  storage: Pick<Storage, "getItem"> | undefined = storageOf(),
): InstalledPetActionPack[] => {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PET_ACTION_PACKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => validatePetActionPack(item))
      .filter((result): result is { ok: true; pack: InstalledPetActionPack } => result.ok)
      .map((result) => clonePack(result.pack));
  } catch {
    return [];
  }
};

const writeInstalledPetActionPacks = (
  packs: readonly InstalledPetActionPack[],
  storage: Pick<Storage, "setItem"> | undefined = storageOf(),
): void => {
  if (!storage) return;
  storage.setItem(PET_ACTION_PACKS_STORAGE_KEY, JSON.stringify(packs));
  emitChanged();
};

export const installPetActionPack = (
  pack: InstalledPetActionPack,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = storageOf(),
): InstalledPetActionPack[] => {
  const current = loadInstalledPetActionPacks(storage);
  const next = [...current.filter((item) => item.id !== pack.id), clonePack(pack)];
  writeInstalledPetActionPacks(next, storage);
  return next;
};

export const removePetActionPack = (
  id: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = storageOf(),
): InstalledPetActionPack[] => {
  const next = loadInstalledPetActionPacks(storage).filter((item) => item.id !== id);
  writeInstalledPetActionPacks(next, storage);
  if (storage?.getItem(PET_ACTION_PACK_ACTIVE_KEY) === id) {
    storage.removeItem(PET_ACTION_PACK_ACTIVE_KEY);
    emitChanged();
  }
  return next;
};

export const getActivePetActionPackId = (
  storage: Pick<Storage, "getItem"> | undefined = storageOf(),
): string | undefined => {
  const value = storage?.getItem(PET_ACTION_PACK_ACTIVE_KEY)?.trim();
  return value || undefined;
};

export const setActivePetActionPackId = (
  id: string | undefined,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = storageOf(),
): void => {
  if (!storage) return;
  if (id) storage.setItem(PET_ACTION_PACK_ACTIVE_KEY, id);
  else storage.removeItem(PET_ACTION_PACK_ACTIVE_KEY);
  emitChanged();
};

export function useInstalledPetActionPacks(): {
  packs: InstalledPetActionPack[];
  activeId?: string;
  activePack?: InstalledPetActionPack;
  install: (pack: InstalledPetActionPack) => void;
  remove: (id: string) => void;
  activate: (id?: string) => void;
} {
  const [packs, setPacks] = useState<InstalledPetActionPack[]>(() => loadInstalledPetActionPacks());
  const [activeId, setActiveId] = useState<string | undefined>(() => getActivePetActionPackId());
  useEffect(() => {
    const refresh = () => {
      setPacks(loadInstalledPetActionPacks());
      setActiveId(getActivePetActionPackId());
    };
    window.addEventListener(PET_ACTION_PACKS_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(PET_ACTION_PACKS_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  const install = useCallback((pack: InstalledPetActionPack) => {
    installPetActionPack(pack);
    setPacks(loadInstalledPetActionPacks());
  }, []);
  const remove = useCallback((id: string) => {
    removePetActionPack(id);
    setPacks(loadInstalledPetActionPacks());
    setActiveId(getActivePetActionPackId());
  }, []);
  const activate = useCallback((id?: string) => {
    setActivePetActionPackId(id);
    setActiveId(id);
  }, []);
  return {
    packs,
    activeId,
    activePack: packs.find((pack) => pack.id === activeId),
    install,
    remove,
    activate,
  };
}
