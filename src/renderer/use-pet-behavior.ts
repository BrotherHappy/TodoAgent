import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canInterruptPetAction,
  emotionForPetAction,
  idleActionDelayMs,
  idleActionDurationMs,
  interactionResponse,
  petActionDefinitions,
  petActionLabels,
  pickIdlePetAction,
  resolvePetAction,
  type PetAction,
  type PetActionPack,
  type PetBehaviorContext,
  type PetEmotion,
  type PetIdleActionProfile,
  type PetInteractionKind,
} from "./pet-behavior";

interface TransientPetBehavior {
  action: PetAction;
  emotion: PetEmotion;
  message?: string;
  token: number;
}

export interface PetBehaviorController {
  action: PetAction;
  emotion: PetEmotion;
  actionLabel: string;
  message?: string;
  interact(kind: PetInteractionKind): void;
  act(action: PetAction, message?: string, durationMs?: number): void;
  celebrate(message?: string): void;
  taskDrop(message?: string): void;
  taskComplete(message?: string): void;
  startDragging(): void;
  stopDragging(): void;
  dismiss(): void;
}

export function usePetBehavior(
  context: PetBehaviorContext,
  name: string,
  enabled: boolean,
  actionPack: PetActionPack = "balanced",
  customIdleProfile?: PetIdleActionProfile,
): PetBehaviorController {
  const [transient, setTransient] = useState<TransientPetBehavior>();
  const clearTimerRef = useRef<number | undefined>(undefined);
  const idleTimerRef = useRef<number | undefined>(undefined);
  const tokenRef = useRef(0);
  const systemAction = useMemo(
    () => resolvePetAction(context),
    [
      context.agentRunState,
      context.agentSending,
      context.approvalPending,
      context.focus?.phase,
      context.focus?.status,
      context.openTaskCount,
      context.overdueCount,
      context.reducedMotion,
      context.syncError,
      context.syncJustCompleted,
      context.syncing,
      context.taskDropActive,
      context.taskTheme,
    ],
  );

  const clearTransient = useCallback(() => {
    if (clearTimerRef.current !== undefined) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = undefined;
    }
    setTransient(undefined);
  }, []);

  const showTransient = useCallback(
    (action: PetAction, durationMs: number, message?: string) => {
      if (!enabled) return;
      const visibleAction = context.reducedMotion ? "idle" : action;
      const ambientSystem =
        systemAction === "idle" ||
        systemAction === "task-clear" ||
        systemAction === "alert";
      if (!ambientSystem && !canInterruptPetAction(systemAction, visibleAction)) return;
      if (
        !ambientSystem &&
        petActionDefinitions[visibleAction].priority <
          petActionDefinitions[systemAction].priority
      ) {
        return;
      }
      tokenRef.current += 1;
      const token = tokenRef.current;
      if (clearTimerRef.current !== undefined) {
        window.clearTimeout(clearTimerRef.current);
      }
      setTransient({
        action: visibleAction,
        emotion: emotionForPetAction(action),
        message,
        token,
      });
      clearTimerRef.current = window.setTimeout(() => {
        setTransient((current) => (current?.token === token ? undefined : current));
        clearTimerRef.current = undefined;
      }, Math.max(600, durationMs));
    },
    [context.reducedMotion, enabled, systemAction],
  );

  useEffect(() => {
    const ambientSystem =
      systemAction === "idle" ||
      systemAction === "task-clear" ||
      systemAction === "alert";
    if (!enabled || context.reducedMotion || !ambientSystem || transient) {
      return undefined;
    }
    const seed = Date.now() + Math.floor(Math.random() * 10_000);
    idleTimerRef.current = window.setTimeout(() => {
      const action = pickIdlePetAction(
        seed,
        new Date().getHours(),
        customIdleProfile ?? actionPack,
      );
      showTransient(action, idleActionDurationMs(action));
    }, idleActionDelayMs(seed, customIdleProfile?.cooldownMs));
    return () => {
      if (idleTimerRef.current !== undefined) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = undefined;
      }
    };
  }, [actionPack, context.reducedMotion, customIdleProfile, enabled, showTransient, systemAction, transient]);

  useEffect(
    () => () => {
      if (clearTimerRef.current !== undefined) {
        window.clearTimeout(clearTimerRef.current);
      }
      if (idleTimerRef.current !== undefined) {
        window.clearTimeout(idleTimerRef.current);
      }
    },
    [],
  );

  const interact = useCallback(
    (kind: PetInteractionKind) => {
      const response = interactionResponse(kind, name);
      showTransient(response.action, response.durationMs, response.message);
    },
    [name, showTransient],
  );
  const act = useCallback(
    (action: PetAction, message?: string, durationMs?: number) => {
      showTransient(
        action,
        durationMs ?? (petActionDefinitions[action].durationMs || 2_800),
        message,
      );
    },
    [showTransient],
  );
  const celebrate = useCallback(
    (message = "完成一件，真不错。") => {
      showTransient("celebrate", 3_500, message);
    },
    [showTransient],
  );
  const taskDrop = useCallback(
    (message = "任务接稳了。想让我怎么处理？") => {
      showTransient("task-drop", 4_600, message);
    },
    [showTransient],
  );
  const taskComplete = useCallback(
    (message = "任务完成，漂亮！") => {
      showTransient("task-complete", 3_800, message);
    },
    [showTransient],
  );
  const startDragging = useCallback(() => {
    showTransient("drag", 60_000);
  }, [showTransient]);
  const stopDragging = useCallback(() => {
    clearTransient();
    showTransient("sit", 1_300);
  }, [clearTransient, showTransient]);

  const ambientSystem =
    systemAction === "idle" ||
    systemAction === "task-clear" ||
    systemAction === "alert";
  const transientWins = Boolean(
    transient &&
      (ambientSystem ||
        (canInterruptPetAction(systemAction, transient.action) &&
          petActionDefinitions[transient.action].priority >=
            petActionDefinitions[systemAction].priority)),
  );
  const action = transientWins && transient ? transient.action : systemAction;
  const emotion = transient && transient.action === action
    ? transient.emotion
    : emotionForPetAction(action);
  return {
    action,
    emotion,
    actionLabel: petActionLabels[action],
    message: transient?.action === action ? transient.message : undefined,
    interact,
    act,
    celebrate,
    taskDrop,
    taskComplete,
    startDragging,
    stopDragging,
    dismiss: clearTransient,
  };
}
