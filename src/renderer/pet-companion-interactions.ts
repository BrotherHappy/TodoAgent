import type { PetCompanionKind, PetPersonality } from "../shared/pet-types";

export interface PetCompanionGreetingInput {
  kind: PetCompanionKind;
  name: string;
  personality: PetPersonality;
}

const kindLines: Record<PetCompanionKind, string> = {
  "paper-bird": "我把下一步折成了一架小纸飞机，等你准备好再出发。",
  cloudlet: "先松一口气吧，慢一点也算在向前走。",
  "moss-mouse": "我在角落里发现了一点秩序，和你一起收好它。",
  "moon-moth": "月光会替你守一会儿安静，专注一小段就好。",
};

const personalityPrefixes: Record<PetPersonality, string> = {
  gentle: "轻轻说：",
  energetic: "挥着小手说：",
  calm: "平静地说：",
  playful: "眨眨眼说：",
  witty: "偷偷笑着说：",
  quiet: "小声说：",
};

export function petCompanionGreeting({
  kind,
  name,
  personality,
}: PetCompanionGreetingInput): string {
  const safeName = name.trim() || "小伙伴";
  return `${safeName}${personalityPrefixes[personality]}${kindLines[kind]}`;
}
