import { afterEach, describe, expect, it, vi } from "vitest";

import {
  markdownToSpeechText,
  speakMarkdown,
  speechOutputSupported,
  stopSpeechOutput,
} from "../src/renderer/speech-output";

class FakeUtterance {
  text: string;
  lang = "";
  rate = 0;
  pitch = 0;
  onend?: () => void;
  onerror?: () => void;

  constructor(text: string) {
    this.text = text;
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
  Reflect.deleteProperty(window, "speechSynthesis");
});

describe("speech output", () => {
  it("turns Markdown into a bounded readable script without reading code", () => {
    const text = markdownToSpeechText(
      "## 今日计划\n\n- **完成同步**\n- [查看资料](https://example.com)\n\n```ts\nsecret()\n```",
    );
    expect(text).toContain("今日计划");
    expect(text).toContain("完成同步");
    expect(text).toContain("查看资料");
    expect(text).toContain("代码块已省略");
    expect(text).not.toContain("secret");
  });

  it("speaks only after an explicit call and supports stop", () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeUtterance,
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak, cancel },
    });
    const onEnd = vi.fn();

    expect(speechOutputSupported()).toBe(true);
    expect(speakMarkdown("你好，**Todo Pet**", { onEnd })).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    const utterance = speak.mock.calls[0]?.[0] as FakeUtterance;
    expect(utterance.text).toBe("你好，Todo Pet");
    expect(utterance.lang).toBe("zh-CN");
    utterance.onend?.();
    expect(onEnd).toHaveBeenCalledOnce();

    stopSpeechOutput();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
