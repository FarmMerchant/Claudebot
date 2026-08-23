/**
 * Per-guild runtime settings, changed from Discord with /voice, /speak and
 * /model.
 *
 * Deliberately in memory only: these are "try something different for a bit"
 * settings, and the defaults in .env are what the bot should come back as
 * after a restart.
 */

import { config, defaultVoiceFor, type TtsEngine } from "./config.js";
import type { AskSettings } from "./claude.js";
import {
  DEFAULT_REPLY_CHARS,
  MAX_REPLY_CHARS,
  MIN_REPLY_CHARS,
  isModelId,
  type Effort,
  type ModelId,
} from "./models.js";

interface GuildPrefs extends AskSettings {
  engine: TtsEngine;
  voice: string;
  /** False means answers are still posted as text, just not read aloud. */
  speaking: boolean;
}

/** CLAUDE_MODEL may name a model /model doesn't offer; fall back rather than crash. */
const DEFAULT_MODEL: ModelId = isModelId(config.claudeModel)
  ? config.claudeModel
  : "claude-haiku-4-5";

const prefs = new Map<string, GuildPrefs>();

function get(guildId: string): GuildPrefs {
  let existing = prefs.get(guildId);
  if (!existing) {
    existing = {
      engine: config.ttsEngine,
      voice: defaultVoiceFor(config.ttsEngine),
      speaking: true,
      model: DEFAULT_MODEL,
      // Spoken answers want latency over depth; /model effort raises it.
      effort: "low",
      maxChars: DEFAULT_REPLY_CHARS,
    };
    prefs.set(guildId, existing);
  }
  return existing;
}

export function engineFor(guildId: string): TtsEngine {
  return get(guildId).engine;
}

/**
 * Switching engine resets the voice: `af_heart` means nothing to Supertonic,
 * and a name the engine does not know would fall back silently on every line.
 * Returns the voice now in effect.
 */
export function setEngineFor(guildId: string, engine: TtsEngine): string {
  const current = get(guildId);
  current.engine = engine;
  current.voice = defaultVoiceFor(engine);
  return current.voice;
}

export function voiceFor(guildId: string): string {
  return get(guildId).voice;
}

export function setVoiceFor(guildId: string, voice: string): void {
  get(guildId).voice = voice;
}

export function speakingIn(guildId: string): boolean {
  return get(guildId).speaking;
}

/** Sets to `on`, or flips the current value when `on` is undefined. */
export function setSpeakingIn(guildId: string, on?: boolean): boolean {
  const current = get(guildId);
  current.speaking = on ?? !current.speaking;
  return current.speaking;
}

/** Exactly what Conversation.ask needs, nothing else. */
export function settingsFor(guildId: string): AskSettings {
  const { model, effort, maxChars } = get(guildId);
  return { model, effort, maxChars };
}

export function setModelFor(guildId: string, model: ModelId): void {
  get(guildId).model = model;
}

export function setEffortFor(guildId: string, effort: Effort): void {
  get(guildId).effort = effort;
}

/** Clamped rather than rejected — the slash command already bounds the input. */
export function setMaxCharsFor(guildId: string, chars: number): number {
  const clamped = Math.min(MAX_REPLY_CHARS, Math.max(MIN_REPLY_CHARS, Math.round(chars)));
  get(guildId).maxChars = clamped;
  return clamped;
}
