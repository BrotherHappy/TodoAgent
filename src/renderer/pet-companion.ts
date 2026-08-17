import type { Task } from "../shared/models";
import type { AppSettings } from "../shared/settings";
import type { WeatherSnapshot } from "../shared/pet-types";

export interface PetCompanionContext {
  settings: AppSettings;
  now: Date;
  focusActive: boolean;
  fullscreen?: boolean;
}

export interface PetProactiveSuggestion {
  kind: "companion" | "planning" | "deadline" | "wellbeing" | "weather" | "sync" | "morning" | "evening";
  action: "wave" | "alert" | "drink" | "think" | "celebrate";
  message: string;
}

function minutesOfDay(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function withinQuietHours(settings: AppSettings, now: Date): boolean {
  if (!settings.notifications.quietHoursEnabled) return false;
  const start = minutesOfDay(settings.notifications.quietHoursStart);
  const end = minutesOfDay(settings.notifications.quietHoursEnd);
  if (start === undefined || end === undefined || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function shouldSuppressPetProactive(
  context: PetCompanionContext,
): boolean {
  const { settings, now } = context;
  if (!settings.pet.proactiveMessages) return true;
  if (settings.pet.meetingMode || context.focusActive) return true;
  if (context.fullscreen && settings.floating.hideInFullscreen) return true;
  if (withinQuietHours(settings, now)) return true;
  const mutedUntil = settings.notifications.mutedUntil;
  return Boolean(mutedUntil && new Date(mutedUntil).getTime() > now.getTime());
}

export function buildPetProactiveSuggestion(input: {
  now: Date;
  tasks: readonly Task[];
  weather?: WeatherSnapshot;
  petName: string;
  syncProblem?: boolean;
}): PetProactiveSuggestion {
  const open = input.tasks.filter(
    (task) => task.status === "open" && !task.deletedAt,
  );
  const date = localDate(input.now);
  const overdue = open.filter(
    (task) => task.dueAt && task.dueAt.slice(0, 10) < date,
  );
  const dueToday = open.filter(
    (task) =>
      task.plannedDate === date || task.dueAt?.slice(0, 10) === date,
  );
  const hour = input.now.getHours();
  if (input.syncProblem) {
    return {
      kind: "sync",
      action: "alert",
      message: "飞书同步遇到一点问题。本地任务还在，我可以陪你稍后重试。",
    };
  }
  if (input.weather?.severe) {
    return {
      kind: "weather",
      action: "alert",
      message: `${input.weather.city}今天${input.weather.conditionLabel}，出门前记得留意天气。`,
    };
  }
  if (hour >= 6 && hour < 11) {
    return {
      kind: "morning",
      action: "wave",
      message: dueToday.length
        ? `早呀！今天有 ${dueToday.length} 件事，先挑一件最值得完成的？`
        : "早呀！今天的任务还很轻，给自己留一点舒服的开始吧。",
    };
  }
  if (hour >= 18) {
    return {
      kind: "evening",
      action: open.length ? "think" : "celebrate",
      message: open.length
        ? `今天辛苦了。还有 ${open.length} 件未完成，要不要一起挪走不着急的？`
        : "今天的清单已经收好啦。现在可以安心休息。",
    };
  }
  if (overdue.length) {
    return {
      kind: "deadline",
      action: "alert",
      message: `有 ${overdue.length} 件事过了计划时间。要不要只重新安排，不责怪自己？`,
    };
  }
  if (open.length >= 7) {
    return {
      kind: "planning",
      action: "think",
      message: `清单里有 ${open.length} 件事。我们可以把今天缩成三件最重要的。`,
    };
  }
  return {
    kind: "wellbeing",
    action: "drink",
    message: `${input.petName}来提醒你：喝口水，转转肩膀，再继续也不迟。`,
  };
}

export function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
