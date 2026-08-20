import type { PetSeason } from "./PetCharacter";

export interface PetSeasonalEvent {
  season: PetSeason;
  label: string;
  icon: string;
  message: string;
}

const EVENTS: Record<PetSeason, Omit<PetSeasonalEvent, "season">> = {
  spring: {
    label: "春日新芽",
    icon: "✿",
    message: "春风把小序的耳朵吹得竖起来了，今天也一起从一小步开始。",
  },
  summer: {
    label: "夏日凉风",
    icon: "☀",
    message: "夏日有点亮，小序把步子放慢一点，陪你稳稳完成下一件事。",
  },
  autumn: {
    label: "秋日拾叶",
    icon: "❧",
    message: "小序捡到一片秋叶，把今天的完成也轻轻收好。",
  },
  winter: {
    label: "冬日围巾",
    icon: "❄",
    message: "围巾已经系好，冷天也可以只做眼前这一小步。",
  },
};

function monthFor(input: Date | string | number): number {
  if (input instanceof Date) return input.getMonth();
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}/.test(input)) {
    return new Date(`${input.slice(0, 10)}T12:00:00`).getMonth();
  }
  return new Date(input).getMonth();
}

/** Monday-independent, local-calendar season mapping used by the pet only. */
export function petSeasonForDate(input: Date | string | number = new Date()): PetSeason {
  const month = monthFor(input);
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

export function petSeasonalEventForDate(
  input: Date | string | number = new Date(),
): PetSeasonalEvent {
  const season = petSeasonForDate(input);
  return { season, ...EVENTS[season] };
}
