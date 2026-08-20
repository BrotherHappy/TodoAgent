import type { PetCompanionKind, PetPersonality } from "../shared/pet-types";

const kindLabels: Record<PetCompanionKind, string> = {
  "paper-bird": "纸飞机",
  cloudlet: "云团",
  "moss-mouse": "苔苔",
  "moon-moth": "月蛾",
};

const kindIcons: Record<PetCompanionKind, string> = {
  "paper-bird": "✦",
  cloudlet: "●",
  "moss-mouse": "◌",
  "moon-moth": "☾",
};

const personalityLabels: Record<PetPersonality, string> = {
  gentle: "温柔",
  energetic: "元气",
  calm: "冷静",
  playful: "活泼",
  witty: "淘气",
  quiet: "安静",
};

export interface PetCompanionAvatarProps {
  kind: PetCompanionKind;
  name: string;
  personality: PetPersonality;
  compact?: boolean;
}

/** A small, CSS-only room companion. It deliberately has no task state. */
export function PetCompanionAvatar({
  kind,
  name,
  personality,
  compact = false,
}: PetCompanionAvatarProps) {
  return (
    <span
      className={`pet-companion-avatar pet-companion-${kind} pet-companion-personality-${personality} ${compact ? "is-compact" : ""}`}
      role="img"
      aria-label={`${name}，${kindLabels[kind]}，${personalityLabels[personality]}陪伴`}
      title={`${name} · ${kindLabels[kind]} · ${personalityLabels[personality]}陪伴`}
    >
      <span className="pet-companion-shadow" aria-hidden="true" />
      <span className="pet-companion-shape" aria-hidden="true">
        <i className="pet-companion-ear pet-companion-ear-left" />
        <i className="pet-companion-ear pet-companion-ear-right" />
        <b>{kindIcons[kind]}</b>
        <i className="pet-companion-eye pet-companion-eye-left" />
        <i className="pet-companion-eye pet-companion-eye-right" />
      </span>
    </span>
  );
}

export { kindIcons, kindLabels, personalityLabels };
