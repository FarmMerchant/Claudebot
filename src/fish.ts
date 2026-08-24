/**
 * Fish Audio (OpenAudio S1-mini), talked to over HTTP.
 *
 * Unlike the other engines this one is not in-process: fish-speech is Python,
 * so it runs as a local sidecar (`python tools/api_server.py --listen
 * 0.0.0.0:8080`) and we POST to it. Nothing leaves the machine — FISH_URL
 * points at localhost — but the bot now depends on a second process being up,
 * which is why every call here fails loudly rather than silently degrading.
 *
 * Its draw over Supertonic and Kokoro is zero-shot voice cloning: drop a wav
 * of someone talking plus a transcript into FISH_VOICES_DIR and it will speak
 * in that voice.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { encode } from "@msgpack/msgpack";
import { config, DISCORD_SAMPLE_RATE } from "./config.js";
import { decodeWav, monoToStereo, resampleStereo, stereoToMono } from "./audio.js";

/** A cloned voice: reference audio plus what is being said in it. */
interface Reference {
  audio: Uint8Array;
  text: string;
}

const references = new Map<string, Reference>();
let voiceNames: string[] | null = null;

function endpoint(pathname: string): string {
  return new URL(pathname, config.fishUrl).toString();
}

/**
 * Voices are `<name>.wav` plus a matching `<name>.txt` holding its transcript.
 * The transcript matters: the model uses it to align the reference, and a
 * wrong one degrades the clone noticeably.
 */
async function scanVoices(): Promise<string[]> {
  if (voiceNames) return voiceNames;
  if (!config.fishVoicesDir) return (voiceNames = []);

  let entries: string[];
  try {
    entries = await readdir(config.fishVoicesDir);
  } catch (err) {
    console.error(`[fish] can't read ${config.fishVoicesDir}: ${describe(err)}`);
    return (voiceNames = []);
  }

  voiceNames = entries
    .filter((name) => name.toLowerCase().endsWith(".wav"))
    .map((name) => name.slice(0, -4))
    .sort();
  return voiceNames;
}

async function referenceFor(voice: string): Promise<Reference | null> {
  const names = await scanVoices();
  if (!names.includes(voice)) return null;

  const cached = references.get(voice);
  if (cached) return cached;

  const dir = config.fishVoicesDir;
  const audio = await readFile(path.join(dir, `${voice}.wav`));
  let text = "";
  try {
    text = (await readFile(path.join(dir, `${voice}.txt`), "utf8")).trim();
  } catch {
    // A reference with no transcript still clones, just less accurately.
    console.warn(`[fish] ${voice}.txt is missing — the clone will be rougher`);
  }

  const reference: Reference = { audio: new Uint8Array(audio), text };
  references.set(voice, reference);
  return reference;
}

/** The sidecar is a separate process; say so plainly when it isn't there. */
export async function fishHealthy(): Promise<boolean> {
  try {
    const response = await fetch(endpoint("/v1/health"), {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function warmFish(): Promise<void> {
  if (!(await fishHealthy())) {
    throw new Error(
      `no fish-speech server at ${config.fishUrl} — start it with tools/api_server.py`,
    );
  }
  await fishSynthesize("Ready.");
}

export async function fishVoices(): Promise<string[]> {
  return scanVoices();
}

async function requestTts(text: string, voice?: string): Promise<Buffer> {
  const reference = voice ? await referenceFor(voice) : null;

  // The server speaks msgpack (ormsgpack), not JSON.
  const body = encode({
    text,
    format: "wav",
    // Chunking is ours to do — we stream sentence by sentence.
    chunk_length: 300,
    max_new_tokens: 1024,
    top_p: 0.8,
    repetition_penalty: 1.1,
    temperature: 0.8,
    normalize: true,
    streaming: false,
    // Keeping the reference encoded between calls is a large speedup.
    use_memory_cache: "on",
    references: reference ? [{ audio: reference.audio, text: reference.text }] : [],
    reference_id: reference ? null : config.fishReferenceId || null,
  });

  const response = await fetch(endpoint("/v1/tts"), {
    method: "POST",
    headers: { "content-type": "application/msgpack" },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`fish-speech returned ${response.status}: ${detail.slice(0, 200)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Whatever the server's rate and channel count, hand back 48 kHz stereo. */
function toDiscordPcm(wav: Buffer): Buffer {
  const decoded = decodeWav(wav);
  if (decoded.pcm.length === 0) throw new Error("fish-speech returned empty audio");

  const stereo =
    decoded.channels === 1
      ? monoToStereo(decoded.pcm)
      : decoded.channels === 2
        ? decoded.pcm
        : monoToStereo(stereoToMono(decoded.pcm));

  return resampleStereo(stereo, decoded.sampleRate, DISCORD_SAMPLE_RATE);
}

export async function fishSynthesize(text: string, voice?: string): Promise<Buffer> {
  return toDiscordPcm(await requestTts(text, voice));
}

/** Sentence at a time, same contract as the other engines. */
export async function* fishStream(
  text: string,
  voice?: string,
): AsyncGenerator<Buffer> {
  for (const sentence of splitSentences(text)) {
    yield toDiscordPcm(await requestTts(sentence, voice));
  }
}

function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [text];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
