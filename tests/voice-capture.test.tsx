import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceCapture } from "../src/renderer/voice-capture";

class FakeRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn(() => this.onend?.());

  emitResult(
    transcript: string,
    isFinal: boolean,
    resultIndex = 0,
  ): void {
    this.onresult?.({
      resultIndex,
      results: [
        {
          isFinal,
          length: 1,
          0: { transcript },
        },
      ],
    });
  }

  emitError(error: string): void {
    this.onerror?.({ error });
  }
}

let activeRecognition: FakeRecognition | undefined;

afterEach(() => {
  activeRecognition = undefined;
  delete (window as Window & { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});
describe("voice capture", () => {
  it("is explicit, returns interim text, and only commits finalized text", () => {
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: class extends FakeRecognition {
        constructor() {
          super();
          activeRecognition = this;
        }
      },
    });
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceCapture({ onFinal }));
    expect(result.current.listening).toBe(false);

    act(() => result.current.start());
    expect(result.current.listening).toBe(true);
    expect(activeRecognition?.lang).toBe("zh-CN");
    expect(activeRecognition?.start).toHaveBeenCalledTimes(1);

    act(() => activeRecognition?.emitResult("整理周报", false));
    expect(result.current.interimTranscript).toBe("整理周报");
    expect(onFinal).not.toHaveBeenCalled();

    act(() => activeRecognition?.emitResult("整理周报", true));
    expect(result.current.transcript).toBe("整理周报");
    expect(onFinal).toHaveBeenCalledWith("整理周报");

    act(() => result.current.stop());
    expect(result.current.listening).toBe(false);
    expect(activeRecognition?.stop).toHaveBeenCalledTimes(1);
  });

  it("fails with a user-readable permission message and never auto-starts", () => {
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: class extends FakeRecognition {
        constructor() {
          super();
          activeRecognition = this;
        }
      },
    });
    const { result } = renderHook(() => useVoiceCapture());
    expect(activeRecognition).toBeUndefined();
    act(() => result.current.start());
    act(() => activeRecognition?.emitError("not-allowed"));
    expect(result.current.state).toBe("error");
    expect(result.current.error).toContain("麦克风权限");
  });

  it("reports unsupported environments without throwing", () => {
    const { result } = renderHook(() => useVoiceCapture());
    act(() => result.current.start());
    expect(result.current.supported).toBe(false);
    expect(result.current.state).toBe("error");
    expect(result.current.error).toContain("不支持");
  });
});
