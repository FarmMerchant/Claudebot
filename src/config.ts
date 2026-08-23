import "dotenv/config";

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name} — ${hint}`);
    console.error("Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  return value;
}

/** Only required for the engine actually in use, so the other stays optional. */
function requiredFor(engine: string, name: string, hint: string): string {
  return ttsEngine === engine ? required(name, hint) : process.env[name] || "";
}

export const TTS_ENGINES = ["supertonic", "kokoro", "piper"] as const;
export type TtsEngine = (typeof TTS_ENGINES)[number];

const KOKORO_DTYPES = ["fp32", "fp16", "q8", "q4", "q4f16"] as const;
type KokoroDtype = (typeof KOKORO_DTYPES)[number];

function oneOf<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = (process.env[name] || fallback).toLowerCase();
  if (!allowed.includes(value as T)) {
    console.error(
      `${name}=${value} is not valid — expected one of: ${allowed.join(", ")}`,
    );
    process.exit(1);
  }
  return value as T;
}

const ttsEngine: TtsEngine = oneOf("TTS_ENGINE", TTS_ENGINES, "supertonic");

export const config = {
  discordToken: required("DISCORD_TOKEN", "your bot token"),
  discordClientId: required("DISCORD_CLIENT_ID", "your application ID"),
  discordGuildId: process.env.DISCORD_GUILD_ID || undefined,

  // Speech-to-text: whisper.cpp, run locally.
  whisperBin: required("WHISPER_BIN", "path to whisper-cli.exe"),
  whisperModel: required("WHISPER_MODEL", "path to a ggml-*.bin model file"),
  whisperThreads: process.env.WHISPER_THREADS || "4",
  whisperLanguage: process.env.WHISPER_LANGUAGE || "en",

  // Text-to-speech. Kokoro needs nothing installed; Piper needs its binary.
  ttsEngine,
  kokoroVoice: process.env.KOKORO_VOICE || "af_heart",
  // fp32 is deliberate: q8 benchmarks ~3x slower on a desktop CPU.
  kokoroDtype: oneOf<KokoroDtype>("KOKORO_DTYPE", KOKORO_DTYPES, "fp32"),
  // 1 is the model natural pace; 1.1-1.2 tightens up a slow-feeling voice.
  kokoroSpeed: Number(process.env.KOKORO_SPEED) || 1,
  // Supertonic: the fast engine. Assets are a separate ~255 MB download.
  supertonicDir: requiredFor(
    "supertonic",
    "SUPERTONIC_DIR",
    "folder containing onnx/ and voice_styles/",
  ),
  supertonicVoice: process.env.SUPERTONIC_VOICE || "F1",
  // Diffusion steps. 8 is their default; 2 is measurably faster and only
  // slightly rougher, which is a good trade for speech nobody re-reads.
  supertonicSteps: Number(process.env.SUPERTONIC_STEPS) || 4,
  supertonicSpeed: Number(process.env.SUPERTONIC_SPEED) || 1.05,

  piperBin: requiredFor("piper", "PIPER_BIN", "path to piper.exe"),
  piperModel: requiredFor("piper", "PIPER_MODEL", "path to a .onnx voice file"),

  claudeModel: process.env.CLAUDE_MODEL || "claude-haiku-4-5",
  wakePhrase: (process.env.WAKE_PHRASE || "hey claude").toLowerCase(),

  // Folder of .wav files for the random outbursts. Unset disables them.
  outburstSoundsDir: process.env.OUTBURST_SOUNDS_DIR || undefined,
} as const;

/** Discord voice is always 48 kHz, 16-bit signed little-endian, stereo. */
export const DISCORD_SAMPLE_RATE = 48_000;
/** whisper.cpp only accepts 16 kHz mono. */
export const WHISPER_SAMPLE_RATE = 16_000;
/**
 * How long someone may pause before we call the utterance finished and send it
 * for transcription. Too short splits sentences; too long delays every answer.
 */
export const UTTERANCE_SILENCE_MS = 800;
/** Ignore bursts shorter than this — coughs, keyboard noise, mic pops. */
export const MIN_UTTERANCE_MS = 400;
/** After "Hey Claude" with no question attached, keep listening this long. */
export const ARMED_TIMEOUT_MS = 12_000;
/**
 * Unprompted outbursts: every tick the bot rolls for one, so it occasionally
 * makes a noise nobody asked for. 1-in-10,000 per second averages out to
 * roughly one every three hours it spends sitting in a channel.
 */
export const OUTBURST_TICK_MS = 1_000;
export const OUTBURST_CHANCE = 1 / 10_000;

/**
 * Each engine names its voices differently, so a guild switching engines has
 * to fall back to that engine's own default rather than keep a name the new
 * one has never heard of.
 */
export function defaultVoiceFor(engine: TtsEngine): string {
  if (engine === "supertonic") return config.supertonicVoice;
  if (engine === "kokoro") return config.kokoroVoice;
  return ""; // Piper's voice is a model path fixed at startup.
}

export function isTtsEngine(value: string): value is TtsEngine {
  return (TTS_ENGINES as readonly string[]).includes(value);
}
