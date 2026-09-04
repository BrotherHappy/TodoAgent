import { afterEach, describe, expect, it, vi } from "vitest";
import {
  environmentSoundOptions,
  FocusEnvironmentSound,
} from "../src/renderer/focus-environment-sound";

function installFakeAudioContext() {
  const contexts: Array<{
    source: {
      buffer?: unknown;
      loop: boolean;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    };
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  class FakeAudioContext {
    sampleRate = 8;
    destination = {};
    readonly source = {
      loop: false,
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    readonly resume = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    readonly filter = {
      type: "lowpass",
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: vi.fn(),
    };
    readonly gain = {
      gain: { value: 0 },
      connect: vi.fn(),
    };

    constructor() {
      contexts.push({
        source: this.source,
        resume: this.resume,
        close: this.close,
      });
    }

    createBuffer() {
      return {
        getChannelData: () => new Float32Array(8),
      };
    }

    createBufferSource() {
      return this.source;
    }

    createBiquadFilter() {
      return this.filter;
    }

    createGain() {
      return this.gain;
    }
  }

  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  return contexts;
}

afterEach(() => {
  delete (window as Window & { AudioContext?: unknown }).AudioContext;
});
describe("focus environment sound", () => {
  it("exposes calm, local-only sound choices including an explicit off state", () => {
    expect(environmentSoundOptions.map((option) => option.value)).toEqual([
      "off",
      "rain",
      "forest",
      "cafe",
      "white-noise",
    ]);
    expect(environmentSoundOptions.every((option) => option.description.length > 0)).toBe(true);
  });

  it("starts one looping filtered buffer and tears it down on pause/off", () => {
    const contexts = installFakeAudioContext();
    const engine = new FocusEnvironmentSound();
    engine.setKind("rain");
    expect(engine.kind).toBe("rain");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.source.loop).toBe(true);
    expect(contexts[0]!.source.start).toHaveBeenCalledTimes(1);
    expect(contexts[0]!.resume).toHaveBeenCalledTimes(1);

    engine.setKind("rain");
    expect(contexts).toHaveLength(1);
    engine.setKind("off");
    expect(engine.kind).toBe("off");
    expect(contexts[0]!.source.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Web Audio is unavailable or construction fails", () => {
    const engine = new FocusEnvironmentSound();
    expect(() => engine.setKind("forest")).not.toThrow();
    expect(engine.kind).toBe("forest");

    class BrokenAudioContext {
      constructor() {
        throw new Error("device unavailable");
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: BrokenAudioContext,
    });
    expect(() => engine.setKind("cafe")).not.toThrow();
    engine.dispose();
  });
});
