import type { CSSProperties } from "react";

export type PetMood =
  | "idle"
  | "focus"
  | "syncing"
  | "alert"
  | "happy";

interface PetCharacterProps {
  mood?: PetMood;
  name?: string;
  scalePercent?: number;
  compact?: boolean;
}

const moodLabels: Record<PetMood, string> = {
  idle: "正在陪伴你",
  focus: "正在和你一起专注",
  syncing: "正在同步任务",
  alert: "有一件事需要留意",
  happy: "为你的进展开心",
};

/**
 * Todo Pet's original, code-native mascot. Keeping the character as SVG makes
 * it crisp on Retina/HiDPI displays and lets reduced-motion and mood states be
 * controlled by the same accessible renderer on Windows and macOS.
 */
export function PetCharacter({
  mood = "idle",
  name = "小序",
  scalePercent = 100,
  compact = false,
}: PetCharacterProps) {
  const scale = Math.max(75, Math.min(125, scalePercent)) / 100;
  return (
    <span
      className={`pet-character pet-mood-${mood} ${compact ? "is-compact" : ""}`}
      role="img"
      aria-label={`${name}，${moodLabels[mood]}`}
      style={{ "--pet-scale": scale } as CSSProperties}
    >
      <svg
        viewBox="0 0 104 104"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="pet-body-gradient" x1="18" y1="12" x2="86" y2="94">
            <stop offset="0" stopColor="#8f92ff" />
            <stop offset="0.52" stopColor="#6b67ee" />
            <stop offset="1" stopColor="#514bcf" />
          </linearGradient>
          <linearGradient id="pet-belly-gradient" x1="37" y1="38" x2="68" y2="82">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.94" />
            <stop offset="1" stopColor="#e7e7ff" stopOpacity="0.86" />
          </linearGradient>
          <filter id="pet-shadow" x="-35%" y="-35%" width="170%" height="190%">
            <feDropShadow dx="0" dy="7" stdDeviation="6" floodColor="#373184" floodOpacity="0.28" />
          </filter>
        </defs>

        <ellipse className="pet-ground" cx="52" cy="92" rx="29" ry="6" />
        <g className="pet-float" filter="url(#pet-shadow)">
          <path className="pet-ear pet-ear-left" d="M24 36 24 17 41 28Z" />
          <path className="pet-ear pet-ear-right" d="m80 36 0-19-17 11Z" />
          <path
            className="pet-body"
            d="M22 48c0-18 12-28 30-28s30 10 30 28v22c0 17-12 26-30 26S22 87 22 70Z"
          />
          <ellipse className="pet-belly" cx="52" cy="67" rx="22" ry="22" />
          <g className="pet-face">
            <ellipse className="pet-eye pet-eye-left" cx="41" cy="49" rx="3.4" ry="5" />
            <ellipse className="pet-eye pet-eye-right" cx="63" cy="49" rx="3.4" ry="5" />
            <path className="pet-mouth" d="M47 59c3 3 7 3 10 0" />
            <circle className="pet-cheek" cx="34" cy="58" r="4" />
            <circle className="pet-cheek" cx="70" cy="58" r="4" />
          </g>
          <path className="pet-check" d="m42 71 7 7 14-16" />
          <path className="pet-arm pet-arm-left" d="M25 63c-8 2-10 8-7 13" />
          <path className="pet-arm pet-arm-right" d="M79 62c8 1 11 7 8 13" />
        </g>

        <g className="pet-focus-mark">
          <circle cx="83" cy="24" r="9" />
          <path d="M83 19v6l4 2" />
        </g>
        <g className="pet-sync-mark">
          <path d="M86 20a9 9 0 0 0-14 3" />
          <path d="m71 19 1 5 5-1" />
          <path d="M71 30a9 9 0 0 0 14-3" />
          <path d="m86 31-1-5-5 1" />
        </g>
        <g className="pet-alert-mark">
          <path d="M83 15 92 31H74Z" />
          <path d="M83 21v5M83 28v1" />
        </g>
        <g className="pet-happy-mark">
          <path d="m84 15 2.3 5.8 6.2.4-4.8 4 1.5 6-5.2-3.4-5.2 3.4 1.5-6-4.8-4 6.2-.4Z" />
        </g>
      </svg>
    </span>
  );
}
