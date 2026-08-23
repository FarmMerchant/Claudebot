import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, WHISPER_SAMPLE_RATE } from "./config.js";
import { pcmToWav } from "./audio.js";

/**
 * Whisper fills silence with plausible-sounding filler — subtitle credits,
 * "thank you", bracketed sound descriptions. Drop the known offenders rather
 * than waking the bot up on room noise.
 */
const HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "bye",
  "so",
  "okay",
  "oh",
  ".",
  "",
]);

function clean(raw: string): string {
  const text = raw
    // Whisper marks non-speech as [BLANK_AUDIO], (music), *coughs* etc.
    .replace(/[\[(*][^\])*]*[\])*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (HALLUCINATIONS.has(text.toLowerCase().replace(/[.!?]+$/, ""))) return "";
  return text;
}

/**
 * whisper.cpp is CPU-bound, so running one per speaker in parallel just makes
 * everyone wait longer. Transcriptions queue up instead.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

/** @param pcm 16 kHz mono 16-bit PCM. */
export function transcribe(pcm: Buffer): Promise<string> {
  return enqueue(() => runWhisper(pcm));
}

async function runWhisper(pcm: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claudebot-"));
  const wavPath = join(dir, `${randomUUID()}.wav`);
  const outBase = join(dir, "out");

  try {
    await writeFile(wavPath, pcmToWav(pcm, WHISPER_SAMPLE_RATE));

    await run(config.whisperBin, [
      "-m", config.whisperModel,
      "-f", wavPath,
      "-l", config.whisperLanguage,
      "-t", config.whisperThreads,
      "-nt", // no timestamps
      "-otxt",
      "-of", outBase,
    ]);

    const text = await readFile(`${outBase}.txt`, "utf8").catch(() => "");
    return clean(text);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      // Keep only the tail; whisper.cpp is chatty about model load details.
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    child.on("error", (err) =>
      reject(
        new Error(
          `Could not run ${command}: ${err.message}. Check WHISPER_BIN in .env.`,
        ),
      ),
    );

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`whisper.cpp exited with code ${code}: ${stderr}`));
    });
  });
}
