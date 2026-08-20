import {
  Activity,
  Check,
  CircleDot,
  Cookie,
  Heart,
  Play,
  Sparkles,
  Sun,
  WandSparkles,
} from "lucide-react";
import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { PetInteractionKind } from "./pet-behavior";

export type FloatingPetGame = "jump-rope" | "stretch-mirror";

interface WheelAction {
  label: string;
  ariaLabel?: string;
  icon: ReactNode;
  kind?: PetInteractionKind;
  game?: FloatingPetGame;
}

const wheelActions: readonly WheelAction[] = [
  { label: "摸摸头", icon: <Heart size={17} />, kind: "head-pat" },
  { label: "挠痒痒", icon: <Sparkles size={17} />, kind: "tickle" },
  { label: "击掌", icon: <Check size={17} />, kind: "high-five" },
  { label: "毛线球", ariaLabel: "玩毛线球", icon: <CircleDot size={17} />, kind: "play" },
  { label: "喂零食", icon: <Cookie size={17} />, kind: "treat" },
  { label: "戳肚子", ariaLabel: "轻戳肚子", icon: <WandSparkles size={17} />, kind: "belly-poke" },
  { label: "喝水", ariaLabel: "一起休息", icon: <Sun size={17} />, kind: "rest" },
  { label: "跳绳", icon: <Play size={17} />, game: "jump-rope" },
  { label: "伸展", icon: <Activity size={17} />, game: "stretch-mirror" },
];

export interface PetInteractionWheelProps {
  petName: string;
  onInteract: (kind: PetInteractionKind) => void;
  onStartGame: (game: FloatingPetGame) => void;
  onClose: () => void;
}

/**
 * A compact radial menu with roving keyboard focus. The menu is a separate
 * leaf so opening it does not make the full floating task panel re-render on
 * every focus move.
 */
export function PetInteractionWheel({
  petName,
  onInteract,
  onStartGame,
  onClose,
}: PetInteractionWheelProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, []);

  const moveFocus = (
    event: KeyboardEvent<HTMLDivElement>,
    mode: "next" | "previous" | "first" | "last",
  ) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      mode === "first"
        ? 0
        : mode === "last"
          ? items.length - 1
          : mode === "previous"
            ? (current <= 0 ? items.length : current) - 1
            : (current + 1) % items.length;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="pet-interaction-wheel no-drag"
      role="menu"
      aria-label="宠物互动轮盘"
      aria-description={`选择一种方式和${petName}互动`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          moveFocus(event, "next");
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          moveFocus(event, "previous");
        } else if (event.key === "Home") {
          moveFocus(event, "first");
        } else if (event.key === "End") {
          moveFocus(event, "last");
        }
      }}
    >
      {wheelActions.map((action, index) => (
        <button
          key={action.label}
          className={action.game ? "is-game" : undefined}
          style={
            {
              "--wheel-angle": `${index * (360 / wheelActions.length)}deg`,
              "--wheel-counter-angle": `${index * (-360 / wheelActions.length)}deg`,
              "--wheel-delay": `${index * 18}ms`,
            } as CSSProperties
          }
          type="button"
          role="menuitem"
          aria-label={
            action.game === "stretch-mirror"
              ? "开始镜像伸展"
              : action.game === "jump-rope"
                ? "开始协作跳绳"
                : (action.ariaLabel ?? action.label)
          }
          onClick={() => {
            if (action.game) onStartGame(action.game);
            else if (action.kind) onInteract(action.kind);
          }}
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}
