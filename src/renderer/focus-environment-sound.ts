/**
 * A tiny, local-only ambience generator for focus sessions.
 *
 * We deliberately synthesize a short noise buffer instead of shipping remote
 * audio or opening a network connection.  The setting is an opt-in comfort
 * layer: the engine is silent when focus is paused, in a break, or ended, and
 * every failure (unsupported Web Audio, autoplay policy, or a broken device)
 * degrades to silence without affecting task state.
 */

export type EnvironmentSoundKind =
  | "off"
  | "rain"
  | "forest"
  | "cafe"
  | "white-noise";

export const environmentSoundOptions: readonly {
  value: EnvironmentSoundKind;
  label: string;
  description: string;
}[] = [
  { value: "off", label: "关闭", description: "专注时保持安静" },
  { value: "rain", label: "轻雨", description: "柔和、连续的雨声质感" },
  { value: "forest", label: "林间", description: "低频、舒缓的自然底噪" },
  { value: "cafe", label: "咖啡馆", description: "温暖、克制的人声背景感" },
  { value: "white-noise", label: "白噪音", description: "均匀的专注遮罩" },
];

interface SoundProfile {
  filter: BiquadFilterType;
  frequency: number;
  q: number;
  volume: number;
}
const profiles: Record<Exclude<EnvironmentSoundKind, "off">, SoundProfile> = {
  rain: { filter: "bandpass", frequency: 2_200, q: 0.38, volume: 0.038 },
  forest: { filter: "lowpass", frequency: 1_250, q: 0.26, volume: 0.030 },
  cafe: { filter: "bandpass", frequency: 760, q: 0.22, volume: 0.026 },
  "white-noise": {
    filter: "highpass",
    frequency: 70,
    q: 0.12,
    volume: 0.022,
  },
};

function audioContextConstructor():
  | (new () => AudioContext)
  | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: new () => AudioContext })
      .webkitAudioContext;
  return candidate;
}

function makeNoiseBuffer(context: AudioContext): AudioBuffer {
  // Two seconds is long enough to avoid a noticeable loop while staying tiny
  // in memory. A shaped filter and very low gain do the rest of the work.
  const length = Math.max(1, Math.floor(context.sampleRate * 2));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) {
    // A bounded random walk creates a less harsh texture than raw white noise.
    const random = Math.random() * 2 - 1;
    channel[index] = random * 0.72;
  }
  return buffer;
}

export class FocusEnvironmentSound {
  #context?: AudioContext;
  #source?: AudioBufferSourceNode;
  #kind: EnvironmentSoundKind = "off";

  get kind(): EnvironmentSoundKind {
    return this.#kind;
  }

  setKind(kind: EnvironmentSoundKind): void {
    if (kind === this.#kind && (kind === "off" || this.#source)) return;
    this.stop();
    this.#kind = kind;
    if (kind === "off") return;

    const Constructor = audioContextConstructor();
    if (!Constructor) return;
    try {
      const context = new Constructor();
      const profile = profiles[kind];
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      source.buffer = makeNoiseBuffer(context);
      source.loop = true;
      filter.type = profile.filter;
      filter.frequency.value = profile.frequency;
      filter.Q.value = profile.q;
      gain.gain.value = profile.volume;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      source.start();
      this.#context = context;
      this.#source = source;
      // Chromium can start a context suspended when a focus session was
      // started from another renderer. Resuming is best-effort and never
      // surfaces an error to the task UI.
      void context.resume().catch(() => undefined);
    } catch {
      this.#context = undefined;
      this.#source = undefined;
    }
  }

  stop(): void {
    const source = this.#source;
    const context = this.#context;
    this.#source = undefined;
    this.#context = undefined;
    if (source) {
      try {
        source.stop();
      } catch {
        // The source may already have stopped during a device transition.
      }
      try {
        source.disconnect();
      } catch {
        // Ignore a partially torn-down graph.
      }
    }
    if (context) void context.close().catch(() => undefined);
    this.#kind = "off";
  }

  dispose(): void {
    this.stop();
  }
}
