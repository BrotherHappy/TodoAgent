import { Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import {
  speakMarkdown,
  speechOutputSupported,
  stopSpeechOutput,
} from "./speech-output";

interface SpeechOutputButtonProps {
  text: string;
  label?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * A deliberately explicit local speech control. It never starts on mount,
 * never streams partial text, and shares one active utterance with every
 * surface (Agent, morning brief and Todo Pet bubbles).
 */
export function SpeechOutputButton({
  text,
  label = "朗读",
  ariaLabel,
  className = "agent-speak-button",
}: SpeechOutputButtonProps): ReactElement {
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);
  const supported = speechOutputSupported();

  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

  useEffect(() => {
    // A rotating task or a refreshed brief must not keep reading stale text.
    if (speakingRef.current) {
      stopSpeechOutput();
      speakingRef.current = false;
      setSpeaking(false);
    }
  }, [text]);

  useEffect(
    () => () => {
      if (speakingRef.current) stopSpeechOutput();
    },
    [],
  );

  const toggleSpeech = () => {
    if (speaking) {
      stopSpeechOutput();
      speakingRef.current = false;
      setSpeaking(false);
      return;
    }
    const started = speakMarkdown(text, {
      onEnd: () => {
        speakingRef.current = false;
        setSpeaking(false);
      },
      onError: () => {
        speakingRef.current = false;
        setSpeaking(false);
      },
    });
    if (started) {
      speakingRef.current = true;
      setSpeaking(true);
    }
  };

  const idleLabel = ariaLabel ?? label;
  const activeLabel = `停止${label}`;

  return (
    <button
      type="button"
      className={className}
      aria-label={speaking ? activeLabel : idleLabel}
      title={supported ? (speaking ? activeLabel : idleLabel) : "当前环境不支持朗读"}
      disabled={!supported || !text.trim()}
      aria-pressed={speaking}
      onClick={toggleSpeech}
    >
      {speaking ? <Square size={12} /> : <Volume2 size={14} />}
      <span>{speaking ? activeLabel : label}</span>
    </button>
  );
}
