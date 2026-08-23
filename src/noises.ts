/**
 * The random outbursts, loaded from a folder of .wav files.
 *
 * Whatever is in OUTBURST_SOUNDS_DIR is the pool — drop a file in, restart, and
 * it joins the rotation. Files are decoded once at startup and kept in memory
 * as 48 kHz 16-bit stereo, ready for the voice connection exactly like Piper's
 * output is. Anything unreadable is skipped with a warning rather than taking
 * the bot down.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { config, DISCORD_SAMPLE_RATE } from "./config.js";
import { decodeWav, monoToStereo, resampleStereo } from "./audio.js";

export interface Outburst {
  name: string;
  /** 48 kHz, 16-bit, stereo. */
  pcm: Buffer;
}

let cache: Promise<Outburst[]> | null = null;

/** Memoised: the directory is scanned and decoded once per process. */
export function loadOutbursts(): Promise<Outburst[]> {
  cache ??= scan();
  return cache;
}

/** One of the loaded sounds, picked uniformly. Null if the pool is empty. */
export async function randomOutburst(): Promise<Outburst | null> {
  const sounds = await loadOutbursts();
  if (sounds.length === 0) return null;
  return sounds[Math.floor(Math.random() * sounds.length)];
}

async function scan(): Promise<Outburst[]> {
  const dir = config.outburstSoundsDir;
  if (!dir) {
    console.log("[outburst] OUTBURST_SOUNDS_DIR is unset — outbursts disabled.");
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    console.error(
      `[outburst] can't read ${dir}: ${describe(err)} — outbursts disabled.`,
    );
    return [];
  }

  const files = entries
    .filter((name) => name.toLowerCase().endsWith(".wav"))
    .sort();

  const sounds: Outburst[] = [];
  for (const name of files) {
    try {
      sounds.push({ name, pcm: await loadSound(path.join(dir, name)) });
    } catch (err) {
      console.warn(`[outburst] skipping ${name}: ${describe(err)}`);
    }
  }

  console.log(
    `[outburst] loaded ${sounds.length} of ${files.length} .wav files from ${dir}`,
  );
  return sounds;
}

async function loadSound(file: string): Promise<Buffer> {
  const raw = await readFile(file);
  if (raw.length === 0) throw new Error("file is empty");

  const { pcm, sampleRate, channels } = decodeWav(raw);
  if (pcm.length === 0) throw new Error("no audio data");
  if (channels !== 1 && channels !== 2) {
    throw new Error(`${channels} channels, expected mono or stereo`);
  }

  const stereo = channels === 1 ? monoToStereo(pcm) : pcm;
  return resampleStereo(stereo, sampleRate, DISCORD_SAMPLE_RATE);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
