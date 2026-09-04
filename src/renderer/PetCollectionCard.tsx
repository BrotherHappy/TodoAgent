import { useMemo } from "react";
import type { PetInventoryItem } from "../shared/pet-types";
import { projectPetCollection } from "./pet-collection";

export function PetCollectionCard({
  inventory,
}: {
  inventory: readonly PetInventoryItem[];
}) {
  const collection = useMemo(() => projectPetCollection(inventory), [inventory]);
  return (
    <section className="pet-collection-card" aria-label="共同收藏图鉴">
      <div className="pet-section-heading">
        <div>
          <h3>共同收藏</h3>
          <p>完成任务、专注和小游戏，会留下看得见的纪念。</p>
        </div>
        <span className="pet-collection-progress">
          {collection.unlockedCount}/{collection.totalCount}
        </span>
      </div>
      <div className="pet-collection-grid">
        {collection.items.map((item) => (
          <article
            className={`pet-collection-item ${item.unlocked ? "is-unlocked" : "is-locked"}`}
            key={item.id}
            aria-label={`${item.label}：${item.unlocked ? "已解锁" : `待解锁，${item.unlockHint}`}`}
            title={item.unlocked ? `${item.label} · ${item.kindLabel}` : item.unlockHint}
          >
            <span className="pet-collection-icon" aria-hidden="true">
              {item.unlocked ? item.icon : "?"}
            </span>
            <span className="pet-collection-copy">
              <strong>{item.unlocked ? item.label : "神秘收藏"}</strong>
              <small>{item.unlocked ? item.kindLabel : item.unlockHint}</small>
            </span>
            {item.quantity > 1 && <b aria-label={`拥有 ${item.quantity} 件`}>×{item.quantity}</b>}
          </article>
        ))}
      </div>
    </section>
  );
}
