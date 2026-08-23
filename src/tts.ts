/**
 * Text to speech. Three engines, switchable per guild with /engine:
 *
 *   supertonic (default) — fastest by a wide margin, 10 preset voices.
 *   kokoro               — 28 voices, warmer, roughly 7x slower.
 *   piper                — the original. Fast, robotic, needs a real install.
 *
 * All three return the same thing: 48 kHz, 16-bit, stereo PCM the voice
 * connection can play as-is. The engine is passed in rather than read from
 * config so two guilds can be on different ones at the same time.
 */

import { config, type TtsEngine } from "./config.js";
import { kokoroStream, kokoroSynthesize, kokoroVoices, warmKokoro } from "./kokoro.js";
import {
  SUPERTONIC_VOICES,
  supertonicStream,
  supertonicSynthesize,
  warmSupertonic,
} from "./supertonic.js";
import { piperSynthesize } from "./piper.js";

/**
 * Sentence-at-a-time synthesis. Piper is fast enough that chunking it buys
 * nothing, so it yields the whole line as one buffer.
 */
export async function* synthesizeStream(
  engine: TtsEngine,
  text: string,
  voice?: string,
): AsyncGenerator<Buffer> {
  if (engine === "piper") {
    yield await piperSynthesize(text);
    return;
  }
  if (engine === "supertonic") {
    yield* supertonicStream(text, voice);
    return;
  }
  yield* kokoroStream(text, voice);
}

/** `voice` names a preset for the given engine; Piper ignores it. */
export async function synthesize(
  engine: TtsEngine,
  text: string,
  voice?: string,
): Promise<Buffer> {
  if (engine === "piper") return piperSynthesize(text);
  if (engine === "supertonic") return supertonicSynthesize(text, voice);
  return kokoroSynthesize(text, voice);
}

/**
 * Load an engine's weights and run one throwaway pass. Called at startup for
 * the configured engine, and again by /engine when a guild switches to one
 * that has not been used yet — otherwise that cost lands on the first answer.
 */
export async function warmTts(engine: TtsEngine = config.ttsEngine): Promise<void> {
  if (engine === "piper") return;

  const started = Date.now();

  if (engine === "supertonic") {
    await warmSupertonic();
    console.log(
      `[tts] supertonic ready (voice ${config.supertonicVoice}, ${config.supertonicSteps} steps) in ${Date.now() - started}ms`,
    );
    return;
  }

  await warmKokoro();
  console.log(
    `[tts] kokoro ready (voice ${config.kokoroVoice}, ${config.kokoroDtype}) in ${Date.now() - started}ms`,
  );
}

/**
 * Why an engine can't be selected right now, or null if it can. Engines whose
 * assets were never configured are still valid values of TTS_ENGINE — they
 * just fail at synthesis time, which is far too late to tell anyone.
 */
export function engineUnavailable(engine: TtsEngine): string | null {
  if (engine === "piper" && !config.piperBin) {
    return "PIPER_BIN and PIPER_MODEL are not set in .env";
  }
  if (engine === "supertonic" && !config.supertonicDir) {
    return "SUPERTONIC_DIR is not set in .env";
  }
  return null;
}

export interface VoiceChoice {
  id: string;
  label: string;
}

/** Worst-to-best grades, so the picker can lead with the good voices. */
const GRADES = ["F", "F+", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];

/**
 * The voices available for /voice on a given engine, best first. Empty under
 * Piper, whose voice is a file path chosen at startup rather than a runtime pick.
 */
export async function voiceChoices(
  engine: TtsEngine = config.ttsEngine,
): Promise<VoiceChoice[]> {
  if (engine === "piper") return [];

  if (engine === "supertonic") {
    return SUPERTONIC_VOICES.map((id) => ({
      id,
      label: `${id} — ${id.startsWith("F") ? "Female" : "Male"} preset ${id.slice(1)}`,
    }));
  }

  const voices = await kokoroVoices();
  return Object.entries(voices)
    .map(([id, raw]) => {
      const meta = raw as Record<string, string | undefined>;
      const grade = meta.overallGrade ?? "?";
      return {
        id,
        label: `${id} — ${meta.name} (${meta.gender}, ${meta.language}, grade ${grade})`,
        rank: GRADES.indexOf(grade),
      };
    })
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
    .map(({ id, label }) => ({ id, label }));
}
