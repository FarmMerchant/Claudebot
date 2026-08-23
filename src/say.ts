/**
 * Voice audition CLI. Renders a line of text to sample.wav with the configured
 * engine so you can listen before committing to a voice:
 *
 *   npm run say -- "the quick brown fox"           # current KOKORO_VOICE
 *   npm run say -- "the quick brown fox" bm_george # override the voice
 *   npm run voices                                 # list them all
 *
 * Everything is imported dynamically because config.ts snapshots the
 * environment the moment it loads — the override has to be in place first.
 */

import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);

// dotenv does not overwrite variables that are already set, so this wins.
if (args[1]) {
  process.env.KOKORO_VOICE = args[1];
  process.env.SUPERTONIC_VOICE = args[1];
}

const { config, DISCORD_SAMPLE_RATE } = await import("./config.js");

if (args[0] === "--list") {
  const { voiceChoices } = await import("./tts.js");
  for (const choice of await voiceChoices()) console.log(choice.label);
  process.exit(0);
}

const { pcmToWav } = await import("./audio.js");
const { synthesize } = await import("./tts.js");

const text = args[0] || "Hey, I'm Claude. This is what I sound like now.";

const started = Date.now();
const pcm = await synthesize(config.ttsEngine, text);
const seconds = pcm.length / 4 / DISCORD_SAMPLE_RATE;

await writeFile("sample.wav", pcmToWav(pcm, DISCORD_SAMPLE_RATE, 2));
const voiceName =
  config.ttsEngine === "supertonic" ? config.supertonicVoice : config.kokoroVoice;
const label =
  config.ttsEngine === "piper" ? "piper" : `${config.ttsEngine} / ${voiceName}`;

console.log(
  `${label}: ${seconds.toFixed(2)}s of audio in ${Date.now() - started}ms -> sample.wav`,
);
