/**
 * Supertonic TTS — the fast engine. Roughly 0.13x real-time on a desktop CPU
 * against Kokoro's 0.4x, from four small ONNX graphs rather than one big one.
 *
 * Supertonic publishes no usable npm package (the `supertonic` package on the
 * registry is a 627-byte placeholder), so the inference helper is vendored from
 * their MIT-licensed Node example — see src/vendor/. The models and voice
 * styles are a separate ~255 MB download pointed at by SUPERTONIC_DIR.
 */

import path from "node:path";
import { config, DISCORD_SAMPLE_RATE } from "./config.js";
import { floatToPcm16, monoToStereo, resampleMono } from "./audio.js";
import {
  loadTextToSpeech,
  loadVoiceStyle,
} from "./vendor/supertonic-helper.js";

/** The ten presets shipped in voice_styles/. */
export const SUPERTONIC_VOICES = [
  "F1", "F2", "F3", "F4", "F5",
  "M1", "M2", "M3", "M4", "M5",
] as const;

export type SupertonicVoice = (typeof SUPERTONIC_VOICES)[number];

/**
 * Supertonic renders noticeably quieter than Kokoro (peaks around 0.2 against
 * 0.55), so normalise to a consistent target instead of making people ride the
 * Discord volume slider when they switch engines.
 */
const TARGET_PEAK = 0.6;
const MAX_GAIN = 6;

type Engine = Awaited<ReturnType<typeof loadTextToSpeech>>;

let engine: Promise<Engine> | null = null;
const styles = new Map<string, ReturnType<typeof loadVoiceStyle>>();

function assetDir(): string {
  if (!config.supertonicDir) {
    throw new Error(
      "SUPERTONIC_DIR is not set — point it at the folder holding onnx/ and voice_styles/",
    );
  }
  return config.supertonicDir;
}

function load(): Promise<Engine> {
  engine ??= loadTextToSpeech(path.join(assetDir(), "onnx"), false);
  return engine;
}

function styleFor(voice: string) {
  const name = isSupertonicVoice(voice) ? voice : config.supertonicVoice;
  let style = styles.get(name);
  if (!style) {
    style = loadVoiceStyle([path.join(assetDir(), "voice_styles", `${name}.json`)]);
    styles.set(name, style);
  }
  return style;
}

export function isSupertonicVoice(value: string): value is SupertonicVoice {
  return (SUPERTONIC_VOICES as readonly string[]).includes(value);
}

/** Peak-normalise, then convert to the 48 kHz stereo the voice connection wants. */
function toDiscordPcm(wav: number[] | null, sampleRate: number): Buffer {
  // The vendored call() seeds its accumulator with null, so an empty render
  // comes back as null rather than an empty array.
  if (!wav || wav.length === 0) throw new Error("supertonic produced no audio");

  let peak = 0;
  for (const sample of wav) peak = Math.max(peak, Math.abs(sample));

  const gain = peak > 0 ? Math.min(MAX_GAIN, TARGET_PEAK / peak) : 1;
  const samples = new Float32Array(wav.length);
  for (let i = 0; i < wav.length; i++) samples[i] = wav[i] * gain;

  const mono = floatToPcm16(samples);
  return monoToStereo(resampleMono(mono, sampleRate, DISCORD_SAMPLE_RATE));
}

/** Load the graphs and run one throwaway pass so the first answer isn't slow. */
export async function warmSupertonic(): Promise<void> {
  const tts = await load();
  await tts.call("Ready.", "en", styleFor(config.supertonicVoice), config.supertonicSteps, config.supertonicSpeed);
}

export async function supertonicSynthesize(
  text: string,
  voice?: string,
): Promise<Buffer> {
  const tts = await load();
  const { wav } = await tts.call(
    text,
    "en",
    styleFor(voice ?? config.supertonicVoice),
    config.supertonicSteps,
    config.supertonicSpeed,
  );
  return toDiscordPcm(wav, tts.sampleRate);
}

/**
 * Sentence-at-a-time, same contract as the Kokoro stream. Supertonic's own
 * `call` already chunks long input, but it only returns once everything is
 * rendered — splitting here is what gets the first sentence playing early.
 */
export async function* supertonicStream(
  text: string,
  voice?: string,
): AsyncGenerator<Buffer> {
  const tts = await load();
  const style = styleFor(voice ?? config.supertonicVoice);

  for (const sentence of splitSentences(text)) {
    const { wav } = await tts.call(
      sentence,
      "en",
      style,
      config.supertonicSteps,
      config.supertonicSpeed,
    );
    yield toDiscordPcm(wav, tts.sampleRate);
  }
}

/** Split on sentence enders, keeping the punctuation so prosody survives. */
function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [text];
}
