import { Check, Plus } from "lucide-react";
import type { TaskResearchCard } from "../shared/models";

export interface ResearchCardActionListProps {
  card: TaskResearchCard;
  createdKeys: ReadonlySet<string>;
  busyKey?: string;
  onCreate: (card: TaskResearchCard, actionItem: string, index: number) => void;
}

export function researchCardActionKey(cardId: string, index: number): string {
  return `${cardId}:${index}`;
}

export function ResearchCardActionList({
  card,
  createdKeys,
  busyKey,
  onCreate,
}: ResearchCardActionListProps) {
  return (
    <ul className="research-card-actions" aria-label="研究卡行动项">
      {card.actionItems.map((item, index) => {
        const key = researchCardActionKey(card.id, index);
        const created = createdKeys.has(key);
        const busy = busyKey === key;
        return (
          <li className="research-card-action-row" key={`${card.id}-${index}`}>
            <span>{item}</span>
            <button
              type="button"
              className={`research-card-action-create ${created ? "is-created" : ""}`}
              disabled={created || busy}
              aria-label={
                created
                  ? `已创建行动任务：${item}`
                  : `从研究卡创建任务：${item}`
              }
              title={created ? "本次已创建本地任务" : "创建一个本地任务，不写回飞书"}
              onClick={() => onCreate(card, item, index)}
            >
              {created ? <Check size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
              <span>{created ? "已创建" : busy ? "创建中…" : "创建任务"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
