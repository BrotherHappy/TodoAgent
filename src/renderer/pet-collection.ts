import type { PetInventoryItem } from "../shared/pet-types";

export type PetCollectionKind = "outfit" | "room" | "play" | "memory";

export interface PetCollectionCatalogItem {
  id: string;
  label: string;
  icon: string;
  kind: PetCollectionKind;
  kindLabel: string;
  unlockHint: string;
}

export interface PetCollectionEntry extends PetCollectionCatalogItem {
  unlocked: boolean;
  quantity: number;
}

export interface PetCollectionProjection {
  items: PetCollectionEntry[];
  unlockedCount: number;
  totalCount: number;
}

/**
 * The collection is a read-only projection of the existing PetService
 * inventory. It deliberately contains no task copies or new persistence
 * fields, so a room collection can never drift from actual rewards.
 */
export const petCollectionCatalog: readonly PetCollectionCatalogItem[] = [
  { id: "outfit-scarf", label: "暖暖围巾", icon: "🧣", kind: "outfit", kindLabel: "装扮", unlockHint: "初始拥有" },
  { id: "toy-ball", label: "毛线球", icon: "🧶", kind: "play", kindLabel: "玩具", unlockHint: "初始拥有" },
  { id: "decoration-cloud-lamp", label: "云灯", icon: "☼", kind: "room", kindLabel: "房间摆件", unlockHint: "初始拥有" },
  { id: "adventure-star", label: "冒险星", icon: "✦", kind: "memory", kindLabel: "共同纪念", unlockHint: "完成一次今日冒险" },
  { id: "outfit-explorer", label: "探索帽", icon: "🧢", kind: "outfit", kindLabel: "装扮", unlockHint: "完成一次今日冒险" },
  { id: "decoration-books", label: "任务书架", icon: "▥", kind: "room", kindLabel: "房间摆件", unlockHint: "完成一次今日冒险" },
  { id: "action-inspect", label: "观察动作", icon: "🔍", kind: "play", kindLabel: "动作", unlockHint: "完成一次今日冒险" },
  { id: "decoration-plant", label: "小植物", icon: "♧", kind: "room", kindLabel: "房间摆件", unlockHint: "完成呼吸或伸展小游戏" },
  { id: "prop-teacup", label: "暖茶杯", icon: "☕", kind: "memory", kindLabel: "共同纪念", unlockHint: "完成呼吸或伸展小游戏" },
  { id: "outfit-starlight", label: "星光披风", icon: "✧", kind: "outfit", kindLabel: "装扮", unlockHint: "在接球或跳绳小游戏中得分" },
  { id: "action-dance", label: "轻轻跳舞", icon: "♫", kind: "play", kindLabel: "动作", unlockHint: "在接球或跳绳小游戏中得分" },
];

export function projectPetCollection(
  inventory: readonly PetInventoryItem[],
): PetCollectionProjection {
  const quantities = new Map<string, number>();
  for (const item of inventory) {
    if (!item || typeof item.id !== "string") continue;
    const quantity = Number.isFinite(item.quantity)
      ? Math.max(0, Math.round(item.quantity))
      : 0;
    if (quantity === 0) continue;
    quantities.set(item.id, (quantities.get(item.id) ?? 0) + quantity);
  }
  const items = petCollectionCatalog.map((item) => {
    const quantity = quantities.get(item.id) ?? 0;
    return { ...item, quantity, unlocked: quantity > 0 };
  });
  return {
    items,
    unlockedCount: items.filter((item) => item.unlocked).length,
    totalCount: items.length,
  };
}
