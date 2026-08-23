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

export const config = {
  discordToken: required("DISCORD_TOKEN", "your bot token"),
  discordClientId: required("DISCORD_CLIENT_ID", "your application ID"),
  discordGuildId: process.env.DISCORD_GUILD_ID || undefined,

  // Speech-to-text: whisper.cpp, run locally.
  whisperBin: required("WHISPER_BIN", "path to whisper-cli.exe"),
  whisperModel: required("WHISPER_MODEL", "path to a ggml-*.bin model file"),
  whisperThreads: process.env.WHISPER_THREADS || "4",
  whisperLanguage: process.env.WHISPER_LANGUAGE || "en",

  // Text-to-speech: Piper, run locally.
  piperBin: required("PIPER_BIN", "path to piper.exe"),
  piperModel: required("PIPER_MODEL", "path to a .onnx voice file"),

  claudeModel: process.env.CLAUDE_MODEL || "claude-opus-5",
  wakePhrase: (process.env.WAKE_PHRASE || "hey claude").toLowerCase(),
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
