const MAX_SPEECH_CHARACTERS = 4_000;

export interface SpeechOutputCallbacks {
  onEnd?: () => void;
  onError?: () => void;
}

let activeFinish: (() => void) | undefined;

function speechApi(): SpeechSynthesis | undefined {
  if (typeof window === "undefined") return undefined;
  const api = window.speechSynthesis;
  return api && typeof window.SpeechSynthesisUtterance === "function"
    ? api
    : undefined;
}

/** Convert Markdown into a short, readable local speech script. */
export function markdownToSpeechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/gu, "代码块已省略。")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/^\s*\d+\.\s+/gmu, "")
    .replace(/[*_~`]/gu, "")
    .replace(/[|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SPEECH_CHARACTERS);
}

export function speechOutputSupported(): boolean {
  return Boolean(speechApi());
}

export function stopSpeechOutput(): void {
  const finish = activeFinish;
  activeFinish = undefined;
  finish?.();
  speechApi()?.cancel();
}

export function speakMarkdown(
  markdown: string,
  callbacks: SpeechOutputCallbacks = {},
): boolean {
  const api = speechApi();
  const text = markdownToSpeechText(markdown);
  if (!api || !text) return false;
  const previousFinish = activeFinish;
  activeFinish = undefined;
  previousFinish?.();
  api.cancel();
  const utterance = new window.SpeechSynthesisUtterance(text);
  utterance.lang = /[\u4e00-\u9fff]/u.test(text) ? "zh-CN" : "en-US";
  utterance.rate = 1;
  utterance.pitch = 1;
  let settled = false;
  const finish = (callback?: () => void) => {
    if (settled) return;
    settled = true;
    if (activeFinish === finish) activeFinish = undefined;
    callback?.();
  };
  activeFinish = () => finish(callbacks.onEnd);
  utterance.onend = () => finish(callbacks.onEnd);
  utterance.onerror = () => finish(callbacks.onError);
  api.speak(utterance);
  return true;
}
