import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence?: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex?: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export type VoiceCaptureState = "idle" | "listening" | "error";

export interface UseVoiceCaptureOptions {
  lang?: string;
  /** Called only with newly finalized text, never with interim guesses. */
  onFinal?: (text: string) => void;
}

export interface VoiceCaptureView {
  supported: boolean;
  state: VoiceCaptureState;
  listening: boolean;
  transcript: string;
  interimTranscript: string;
  error?: string;
  start(): void;
  stop(): void;
  toggle(): void;
}

export function speechRecognitionConstructor():
  | SpeechRecognitionConstructor
  | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = window as SpeechRecognitionWindow;
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
}

function friendlyVoiceError(code?: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限未允许，请在系统设置中开启后再试。";
    case "no-speech":
      return "没有听到语音，可以再试一次。";
    case "audio-capture":
      return "暂时无法使用麦克风，请检查其他应用是否正在占用。";
    case "network":
      return "语音识别服务暂时不可用，仍可直接键入。";
    default:
      return "语音输入暂时不可用，仍可直接键入。";
  }
}

/**
 * Explicit, foreground-only voice capture. It never starts by itself, never
 * creates a task, and only returns finalized text to the caller for review.
 */
export function useVoiceCapture({
  lang = "zh-CN",
  onFinal,
}: UseVoiceCaptureOptions = {}): VoiceCaptureView {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<VoiceCaptureState>("idle");
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string>();
  const recognitionRef = useRef<SpeechRecognitionLike | undefined>(undefined);
  const finalTextRef = useRef("");
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    setSupported(Boolean(speechRecognitionConstructor()));
    return () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = undefined;
      if (!recognition) return;
      try {
        recognition.abort();
      } catch {
        // A closed media device is already in the desired terminal state.
      }
    };
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setState("idle");
      setInterimTranscript("");
      return;
    }
    try {
      recognition.stop();
    } catch {
      recognition.abort();
      recognitionRef.current = undefined;
      setState("idle");
      setInterimTranscript("");
    }
  }, []);

  const start = useCallback(() => {
    const Constructor = speechRecognitionConstructor();
    if (!Constructor) {
      setSupported(false);
      setError("当前环境不支持语音输入，请直接键入。");
      setState("error");
      return;
    }
    const existing = recognitionRef.current;
    if (existing) return;
    setSupported(true);
    setError(undefined);
    setTranscript("");
    setInterimTranscript("");
    finalTextRef.current = "";
    const recognition = new Constructor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;
      setState("listening");
    };
    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      const startIndex = Math.max(0, event.resultIndex ?? 0);
      let finalized = "";
      let interim = "";
      for (let index = startIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const value = result?.[0]?.transcript?.trim() ?? "";
        if (!value) continue;
        if (result.isFinal) finalized = `${finalized} ${value}`.trim();
        else interim = `${interim} ${value}`.trim();
      }
      if (finalized) {
        finalTextRef.current = `${finalTextRef.current} ${finalized}`.trim();
        setTranscript(finalTextRef.current);
        onFinalRef.current?.(finalized);
      }
      setInterimTranscript(interim);
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      setError(friendlyVoiceError(event.error));
      setState("error");
      setInterimTranscript("");
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = undefined;
      setInterimTranscript("");
      setState((current) => (current === "error" ? current : "idle"));
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = undefined;
      setError("语音输入没有成功启动，请再试一次。");
      setState("error");
    }
  }, [lang]);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  return {
    supported,
    state,
    listening: state === "listening",
    transcript,
    interimTranscript,
    error,
    start,
    stop,
    toggle,
  };
}
