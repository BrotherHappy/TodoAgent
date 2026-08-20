import { useId, useRef, type CSSProperties, type PointerEvent } from "react";
import type { PetPersonality } from "../shared/pet-types";
import type { PetWeatherEffect } from "./pet-weather-effect";
import {
  petActionLabels,
  type PetAction,
  type PetEmotion,
} from "./pet-behavior";

export type PetMood = "idle" | "focus" | "syncing" | "alert" | "happy";
export type PetPalette = "lavender" | "mint" | "sunset" | "midnight";
export type PetOutfit = "none" | "scarf" | "explorer" | "starlight";
export type PetSeason = "spring" | "summer" | "autumn" | "winter";
export type { PetPersonality };

interface PetCharacterProps {
  mood?: PetMood;
  emotion?: PetEmotion;
  action?: PetAction;
  name?: string;
  scalePercent?: number;
  compact?: boolean;
  interactive?: boolean;
  palette?: PetPalette;
  outfit?: PetOutfit;
  season?: PetSeason;
  weatherEffect?: PetWeatherEffect;
  personality?: PetPersonality;
}

const moodLabels: Record<PetMood, string> = {
  idle: "正在陪伴你",
  focus: "正在和你一起专注",
  syncing: "正在同步任务",
  alert: "有一件事需要留意",
  happy: "为你的进展开心",
};

const moodEmotion: Record<PetMood, PetEmotion> = {
  idle: "calm",
  focus: "focused",
  syncing: "focused",
  alert: "concerned",
  happy: "happy",
};

const emotionLabels: Record<PetEmotion, string> = {
  calm: "平静",
  curious: "好奇",
  happy: "开心",
  excited: "兴奋",
  focused: "专注",
  sleepy: "困倦",
  concerned: "有些担心",
  proud: "很有成就感",
};

const personalityLabels: Record<PetPersonality, string> = {
  gentle: "温柔陪伴",
  energetic: "元气鼓励",
  calm: "冷静管家",
  playful: "活泼淘气",
  witty: "轻微淘气",
  quiet: "安静陪伴",
};

function clampGaze(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * The mascot is an articulated vector rig rather than a static illustration.
 * Head, body, eyes, ears, arms, feet and tail animate independently so a
 * business state changes the pet's posture instead of merely adding a badge.
 */
export function PetCharacter({
  mood = "idle",
  emotion,
  action = "idle",
  name = "小序",
  scalePercent = 100,
  compact = false,
  interactive = false,
  palette = "lavender",
  outfit = "none",
  season,
  weatherEffect,
  personality = "gentle",
}: PetCharacterProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const gradientId = `pet-body-${useId().replaceAll(":", "")}`;
  const bellyGradientId = `pet-belly-${useId().replaceAll(":", "")}`;
  const shadowId = `pet-shadow-${useId().replaceAll(":", "")}`;
  const resolvedEmotion = emotion ?? moodEmotion[mood];
  const scale = Math.max(75, Math.min(125, scalePercent)) / 100;

  const updateGaze = (event: PointerEvent<HTMLSpanElement>) => {
    if (!interactive || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const x = clampGaze(((event.clientX - rect.left) / rect.width - 0.5) * 2);
    const y = clampGaze(((event.clientY - rect.top) / rect.height - 0.5) * 2);
    rootRef.current.style.setProperty("--pet-gaze-x", String(x));
    rootRef.current.style.setProperty("--pet-gaze-y", String(y));
  };
  const resetGaze = () => {
    rootRef.current?.style.setProperty("--pet-gaze-x", "0");
    rootRef.current?.style.setProperty("--pet-gaze-y", "0");
  };

  return (
    <span
      ref={rootRef}
      className={`pet-character pet-mood-${mood} pet-emotion-${resolvedEmotion} pet-action-${action} pet-palette-${palette} pet-outfit-${outfit} pet-personality-${personality} ${season ? `pet-season-${season}` : ""} ${weatherEffect ? `pet-weather-${weatherEffect}` : ""} ${compact ? "is-compact" : ""} ${interactive ? "is-interactive" : ""}`}
      data-pet-action={action}
      data-pet-emotion={resolvedEmotion}
      data-pet-palette={palette}
      data-pet-outfit={outfit}
      data-pet-weather-effect={weatherEffect ?? "clear"}
      data-pet-personality={personality}
      role="img"
      aria-label={`${name}，${personalityLabels[personality]}，${moodLabels[mood]}，${emotionLabels[resolvedEmotion]}，${petActionLabels[action]}`}
      style={{ "--pet-scale": scale } as CSSProperties}
      onPointerMove={updateGaze}
      onPointerLeave={resetGaze}
    >
      <svg viewBox="0 0 120 116" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="22" y1="12" x2="92" y2="101">
            <stop offset="0" stopColor="var(--pet-body-light)" />
            <stop offset="0.56" stopColor="var(--pet-body-mid)" />
            <stop offset="1" stopColor="var(--pet-body-dark)" />
          </linearGradient>
          <linearGradient id={bellyGradientId} x1="40" y1="44" x2="72" y2="91">
            <stop offset="0" stopColor="var(--pet-belly-light)" />
            <stop offset="1" stopColor="var(--pet-belly-dark)" />
          </linearGradient>
          <filter id={shadowId} x="-35%" y="-35%" width="180%" height="200%">
            <feDropShadow dx="0" dy="7" stdDeviation="5.5" floodColor="var(--pet-shadow-color)" floodOpacity="0.28" />
          </filter>
        </defs>

        <ellipse className="pet-ground" cx="57" cy="105" rx="31" ry="5.5" />
        <g className="pet-jump-rope pet-jump-rope-back">
          <path d="M20 78C12 24 31 8 58 8s47 16 44 70" />
        </g>
        <g className="pet-rig" filter={`url(#${shadowId})`}>
          <g className="pet-tail-rig">
            <path className="pet-tail" d="M86 76c17-6 23 3 17 13-3 5-9 6-14 4 7-2 9-8 4-10-3-2-7 0-9 2Z" />
          </g>

          <g className="pet-leg pet-leg-left">
            <ellipse className="pet-foot" cx="42" cy="96" rx="10" ry="6" />
          </g>
          <g className="pet-leg pet-leg-right">
            <ellipse className="pet-foot" cx="74" cy="96" rx="10" ry="6" />
          </g>

          <g className="pet-body-rig">
            <path
              className="pet-body"
              fill={`url(#${gradientId})`}
              d="M27 54c0-20 13-31 30-31s31 11 31 31v24c0 18-12 28-31 28S27 96 27 78Z"
            />
            <ellipse className="pet-belly" fill={`url(#${bellyGradientId})`} cx="57" cy="75" rx="22" ry="23" />
            <path className="pet-check" d="m47 76 7 7 14-16" />
          </g>

          <g className="pet-arm-rig pet-arm-left-rig">
            <path className="pet-arm pet-arm-left" d="M30 60c-10 2-13 10-9 18" />
            <circle className="pet-paw pet-paw-left" cx="21" cy="77" r="4.2" />
          </g>
          <g className="pet-arm-rig pet-arm-right-rig">
            <path className="pet-arm pet-arm-right" d="M84 60c10 2 13 10 9 18" />
            <circle className="pet-paw pet-paw-right" cx="93" cy="77" r="4.2" />
          </g>

          <g className="pet-head-rig">
            <g className="pet-ear-rig pet-ear-left-rig">
              <path className="pet-ear pet-ear-left" fill={`url(#${gradientId})`} d="M29 42 26 17 45 31Z" />
              <path className="pet-ear-inner" d="m31 34-1-10 9 7Z" />
            </g>
            <g className="pet-ear-rig pet-ear-right-rig">
              <path className="pet-ear pet-ear-right" fill={`url(#${gradientId})`} d="m85 42 3-25-19 14Z" />
              <path className="pet-ear-inner" d="m83 34 1-10-9 7Z" />
            </g>
            <ellipse className="pet-head" fill={`url(#${gradientId})`} cx="57" cy="49" rx="31" ry="27" />
            <g className="pet-brows">
              <path className="pet-brow pet-brow-left" d="M40 39c3-2 7-2 10 0" />
              <path className="pet-brow pet-brow-right" d="M64 39c3-2 7-2 10 0" />
            </g>
            <g className="pet-face">
              <g className="pet-eye-open pet-eye-open-left">
                <ellipse className="pet-eye-white" cx="45" cy="49" rx="6.3" ry="8" />
                <circle className="pet-pupil pet-pupil-left" cx="46" cy="50" r="3.7" />
                <circle className="pet-eye-shine" cx="47.2" cy="47.8" r="1.3" />
              </g>
              <g className="pet-eye-open pet-eye-open-right">
                <ellipse className="pet-eye-white" cx="69" cy="49" rx="6.3" ry="8" />
                <circle className="pet-pupil pet-pupil-right" cx="70" cy="50" r="3.7" />
                <circle className="pet-eye-shine" cx="71.2" cy="47.8" r="1.3" />
              </g>
              <g className="pet-closed-eyes">
                <path d="M39 49c3 4 9 4 12 0" />
                <path d="M63 49c3 4 9 4 12 0" />
              </g>
              <circle className="pet-cheek" cx="36" cy="60" r="4.2" />
              <circle className="pet-cheek" cx="78" cy="60" r="4.2" />
              <g className="pet-mouths">
                <path className="pet-mouth pet-mouth-neutral" d="M52 60c3 3 7 3 10 0" />
                <path className="pet-mouth pet-mouth-smile" d="M49 58c4 8 12 8 16 0" />
                <path className="pet-mouth pet-mouth-open" d="M52 58c0 8 10 8 10 0-2-3-8-3-10 0Z" />
                <ellipse className="pet-mouth pet-mouth-o" cx="57" cy="61" rx="4" ry="5" />
                <path className="pet-mouth pet-mouth-worry" d="M51 64c3-4 9-4 12 0" />
                <path className="pet-mouth pet-mouth-focus" d="M53 62h8" />
                <path className="pet-mouth pet-mouth-sleep" d="M52 62c3-2 7-2 10 0" />
              </g>
            </g>
          </g>

          <g className="pet-outfit pet-outfit-scarf-rig">
            <path d="M35 66c14 6 29 6 44 0l-2 9c-13 5-27 5-40 0Z" />
            <path d="M72 72c3 8 4 16 1 23l-8-7 2-15Z" />
          </g>
          <g className="pet-outfit pet-outfit-explorer-rig">
            <path d="M33 30c9-10 39-10 48 0l-5 5H38Z" />
            <path d="M43 24c5-7 23-7 28 0Z" />
            <path d="M82 77c9 2 13 8 11 16l-13-2Z" />
          </g>
          <g className="pet-outfit pet-outfit-starlight-rig">
            <path d="M34 70c8 3 38 3 46 0l8 27-31 7-31-7Z" />
            <path d="m88 34 2 5 5 .4-4 3 1.3 5-4.3-2.8-4.3 2.8 1.3-5-4-3 5-.4Z" />
          </g>

          <g className="pet-season-prop pet-season-prop-spring">
            <path d="m87 19 5-6 5 6-5 6Z" />
            <path d="M91 19c-5 5-8 11-8 18" />
          </g>
          <g className="pet-season-prop pet-season-prop-summer">
            <path d="M28 27c17-8 41-8 58 0l-3 5H31Z" />
            <path d="M47 23c7-4 15-4 22 0" />
          </g>
          <g className="pet-season-prop pet-season-prop-autumn">
            <path d="m92 21 7-3-2 8-6 3Z" />
            <path d="M94 25c-5 8-7 14-7 22" />
          </g>
          <g className="pet-season-prop pet-season-prop-winter">
            <path d="M35 65c13 5 29 5 44 0l-2 8c-13 5-27 5-40 0Z" />
            <path className="pet-season-line" d="M45 68v6M57 69v6M69 68v6" />
          </g>

          <g className="pet-weather-prop pet-weather-prop-rain">
            <path d="M82 29c4-9 17-14 27-7 4 2 7 5 8 9-4-2-7-2-10 1-3-3-7-3-10 0-3-3-7-3-10-1-2-1-3-1-5-2Z" />
            <path className="pet-weather-line" d="M97 31v15c0 5-3 7-6 5" />
            <path className="pet-weather-drop" d="m82 48-2 5M104 48l-2 5" />
          </g>
          <g className="pet-weather-prop pet-weather-prop-snow">
            <path className="pet-weather-line" d="M98 16v16M90 24h16M92 18l12 12M104 18 92 30" />
            <circle className="pet-weather-dot" cx="84" cy="22" r="2" />
            <circle className="pet-weather-dot" cx="108" cy="38" r="2" />
          </g>
          <g className="pet-weather-prop pet-weather-prop-storm">
            <path d="M82 28c3-8 16-12 25-6 4 2 6 5 7 9-4-2-7-2-10 1-3-3-7-3-10 0-4-3-8-3-12-1Z" />
            <path className="pet-weather-lightning" d="m99 32-7 12h6l-4 10 11-16h-6Z" />
          </g>

          <g className="pet-prop pet-prop-book">
            <path d="M34 68c8-3 16-1 23 5v19c-7-6-15-8-23-4Z" />
            <path d="M80 68c-8-3-16-1-23 5v19c7-6 15-8 23-4Z" />
            <path className="pet-prop-line" d="M57 73v19" />
          </g>
          <g className="pet-prop pet-prop-cup">
            <path d="M66 73h17v16c0 5-4 8-8.5 8S66 94 66 89Z" />
            <path className="pet-prop-line" d="M83 78h3c6 0 6 10 0 10h-3M70 69c-3-4 3-5 0-9M77 69c-3-4 3-5 0-9" />
          </g>
          <g className="pet-prop pet-prop-ball">
            <circle cx="86" cy="91" r="11" />
            <path className="pet-prop-line" d="M77 86c6 1 11 6 13 13M82 81c1 7 6 12 13 14" />
          </g>
          <g className="pet-prop pet-prop-snack">
            <circle cx="80" cy="78" r="9" />
            <circle className="pet-snack-chip" cx="76" cy="75" r="1.3" />
            <circle className="pet-snack-chip" cx="83" cy="73" r="1.2" />
            <circle className="pet-snack-chip" cx="82" cy="81" r="1.4" />
            <circle className="pet-snack-chip" cx="76" cy="82" r="1.1" />
          </g>
          <g className="pet-prop pet-prop-headphones">
            <path className="pet-prop-line" d="M33 48c0-17 9-26 24-26s24 9 24 26" />
            <rect x="28" y="43" width="9" height="20" rx="4" />
            <rect x="77" y="43" width="9" height="20" rx="4" />
          </g>
          <g className="pet-prop pet-prop-task-card">
            <rect x="35" y="66" width="45" height="29" rx="6" />
            <path className="pet-prop-line" d="m43 80 5 5 8-11M61 77h11M61 84h9" />
          </g>
          <g className="pet-prop pet-prop-keyboard">
            <rect x="29" y="86" width="56" height="13" rx="4" />
            <path className="pet-prop-line" d="M35 90h4M42 90h4M49 90h4M56 90h4M63 90h4M70 90h4M38 95h30" />
          </g>
          <g className="pet-prop pet-prop-magnifier">
            <circle cx="72" cy="72" r="10" />
            <path className="pet-prop-line" d="m79 79 10 11" />
          </g>
          <g className="pet-prop pet-prop-sync-box">
            <path d="m38 71 19-9 19 9-19 10Z" />
            <path d="m38 71 19 10v15L38 86ZM76 71 57 81v15l19-10Z" />
            <path className="pet-prop-line" d="M48 67 67 77" />
          </g>
        </g>

        <g className="pet-jump-rope pet-jump-rope-front">
          <path d="M20 78c8 32 69 32 82 0" />
        </g>
        <g className="pet-jump-rope pet-jump-rope-handles">
          <path d="m16 72 8 12M98 84l8-12" />
        </g>

        <g className="pet-interaction-effect pet-pat-hand">
          <path className="pet-user-hand" d="M38 6c0-3 5-3 5 0v7-4c0-4 6-4 6 0v4-5c0-4 6-4 6 0v6-3c0-4 6-4 6 0v10c0 8-5 13-13 13-7 0-11-4-14-10l-4-8c-2-4 4-7 7-3l1 2Z" />
          <path className="pet-contact-line" d="M41 38l-3 5M50 39v6M59 38l3 5" />
        </g>
        <g className="pet-interaction-effect pet-poke-finger">
          <path className="pet-user-hand" d="M2 69h33l8-7c4-3 8 1 5 5l-3 3h9c5 0 8 3 8 7s-3 7-8 7H2Z" />
          <path className="pet-hand-cuff" d="M2 69h11v15H2Z" />
          <circle className="pet-contact-dot" cx="60" cy="77" r="3.2" />
        </g>
        <g className="pet-interaction-effect pet-poke-ripple">
          <circle cx="57" cy="77" r="7" />
          <circle cx="57" cy="77" r="13" />
        </g>
        <g className="pet-interaction-effect pet-tickle-feather">
          <path className="pet-feather-stem" d="M106 58c-9 6-16 14-20 25" />
          <path className="pet-feather-fill" d="M105 58c-10-1-18 4-19 12 7 2 15-2 19-12ZM96 67c7 0 11 4 10 9-6 2-11-2-10-9Z" />
        </g>
        <g className="pet-interaction-effect pet-high-five-hand">
          <path className="pet-user-hand" d="M112 32c4-2 7 3 4 6l-5 4 5-1c5-1 7 5 2 7l-6 2 5 1c5 1 4 7-1 7h-13c-8 0-13-5-13-12 0-6 3-11 8-15l7-6c4-3 8 2 5 6l-3 4Z" />
          <path className="pet-contact-line" d="M91 34l-4-5M88 41h-7M94 28l-1-7" />
        </g>

        <g className="pet-action-mark pet-sleep-mark">
          <path d="M84 20h11L84 32h12M76 12h8l-8 9h9" />
        </g>
        <g className="pet-action-mark pet-heart-mark">
          <path d="M91 35c-11-7-16-13-16-19 0-7 9-9 16-2 7-7 16-5 16 2 0 6-5 12-16 19Z" />
        </g>
        <g className="pet-action-mark pet-think-mark">
          <circle cx="84" cy="30" r="3" /><circle cx="94" cy="23" r="4" /><circle cx="104" cy="15" r="5" />
        </g>
        <g className="pet-action-mark pet-approval-mark">
          <path d="M93 12 104 16v9c0 8-4 13-11 17-7-4-11-9-11-17v-9Z" />
          <path className="pet-action-line" d="m88 27 3 3 7-9" />
        </g>
        <g className="pet-action-mark pet-music-mark">
          <path d="M91 16v14c0 5-8 6-8 1 0-4 5-5 8-3M91 19l10-3v11c0 5-8 6-8 1 0-4 5-5 8-3" />
        </g>
        <g className="pet-action-mark pet-confetti-mark">
          <path d="m18 22 4 6M13 36l7 1M96 52l8-3M96 40l5-6" />
          <circle cx="17" cy="17" r="2" /><circle cx="105" cy="30" r="2" />
        </g>
        <g className="pet-action-mark pet-error-mark">
          <circle cx="95" cy="23" r="12" />
          <path d="m90 18 10 10M100 18 90 28" />
        </g>
      </svg>
    </span>
  );
}
