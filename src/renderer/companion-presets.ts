import type { AppSettings } from "../shared/settings";

export type CompanionStrategy = "gentle" | "balanced" | "focused" | "playful";

export const companionStrategyLabels: Record<CompanionStrategy, string> = {
  gentle: "温和陪伴",
  balanced: "自然平衡",
  focused: "深度专注",
  playful: "活泼互动",
};

const strategyValues: Record<CompanionStrategy, {
  actionPack: AppSettings["pet"]["actionPack"];
  animationIntensity: AppSettings["pet"]["animationIntensity"];
  proactiveLevel: AppSettings["persona"]["proactiveLevel"];
  reminderStrength: AppSettings["persona"]["reminderStrength"];
  autoStartBreak: boolean;
  autoStartNextRound: boolean;
}> = {
  gentle: {
    actionPack: "calm",
    animationIntensity: "gentle",
    proactiveLevel: "quiet",
    reminderStrength: "gentle",
    autoStartBreak: false,
    autoStartNextRound: false,
  },
  balanced: {
    actionPack: "balanced",
    animationIntensity: "lively",
    proactiveLevel: "balanced",
    reminderStrength: "gentle",
    autoStartBreak: false,
    autoStartNextRound: false,
  },
  focused: {
    actionPack: "focused",
    animationIntensity: "gentle",
    proactiveLevel: "quiet",
    reminderStrength: "normal",
    autoStartBreak: true,
    autoStartNextRound: true,
  },
  playful: {
    actionPack: "playful",
    animationIntensity: "lively",
    proactiveLevel: "active",
    reminderStrength: "gentle",
    autoStartBreak: false,
    autoStartNextRound: false,
  },
};

export function applyCompanionStrategy(
  settings: AppSettings,
  strategy: CompanionStrategy,
): AppSettings {
  const values = strategyValues[strategy];
  return {
    ...settings,
    pet: {
      ...settings.pet,
      actionPack: values.actionPack,
      animationIntensity: values.animationIntensity,
    },
    persona: {
      ...settings.persona,
      proactiveLevel: values.proactiveLevel,
      reminderStrength: values.reminderStrength,
    },
    focus: {
      ...settings.focus,
      autoStartBreak: values.autoStartBreak,
      autoStartNextRound: values.autoStartNextRound,
    },
  };
}

export function detectCompanionStrategy(
  settings: AppSettings,
): CompanionStrategy | "custom" {
  const match = (Object.keys(strategyValues) as CompanionStrategy[]).find((strategy) => {
    const values = strategyValues[strategy];
    return (
      settings.pet.actionPack === values.actionPack &&
      settings.pet.animationIntensity === values.animationIntensity &&
      settings.persona.proactiveLevel === values.proactiveLevel &&
      settings.persona.reminderStrength === values.reminderStrength &&
      settings.focus.autoStartBreak === values.autoStartBreak &&
      settings.focus.autoStartNextRound === values.autoStartNextRound
    );
  });
  return match ?? "custom";
}
