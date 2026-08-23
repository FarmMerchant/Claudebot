/**
 * Piper TTS — the original engine, kept as the fast fallback. Roughly ten times
 * quicker than Kokoro but noticeably more robotic. Select it with TTS_ENGINE=piper.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { config, DISCORD_SAMPLE_RATE } from "./config.js";
import { monoToStereo, resampleMono } from "./audio.js";

/** Piper voices ship a sibling JSON config that declares their sample rate. */
let voiceSampleRate: number | null = null;

async function getVoiceSampleRate(): Promise<number> {
  if (voiceSampleRate !== null) return voiceSampleRate;

  try {
    const raw = await readFile(`${config.piperModel}.json`, "utf8");
    const parsed = JSON.parse(raw) as { audio?: { sample_rate?: number } };
    voiceSampleRate = parsed.audio?.sample_rate ?? 22_050;
  } catch {
    // Most Piper voices are 22.05 kHz; assume that if the config is missing.
    voiceSampleRate = 22_050;
  }
  return voiceSampleRate;
}

export async function piperSynthesize(text: string): Promise<Buffer> {
  const sampleRate = await getVoiceSampleRate();
  const mono = await runPiper(text);
  return monoToStereo(resampleMono(mono, sampleRate, DISCORD_SAMPLE_RATE));
}

function runPiper(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!config.piperBin || !config.piperModel) {
      reject(new Error("PIPER_BIN and PIPER_MODEL must be set to use TTS_ENGINE=piper"));
      return;
    }

    const child = spawn(
      config.piperBin,
      // Note: --output_raw takes an underscore, unlike Piper's other long flags.
      ["--model", config.piperModel, "--output_raw", "--quiet"],
      { windowsHide: true },
    );

    const chunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    child.on("error", (err) =>
      reject(
        new Error(
          `Could not run ${config.piperBin}: ${err.message}. Check PIPER_BIN in .env.`,
        ),
      ),
    );

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`piper exited with code ${code}: ${stderr}`));
        return;
      }
      const audio = Buffer.concat(chunks);
      if (audio.length === 0) {
        reject(new Error(`piper produced no audio: ${stderr}`));
        return;
      }
      resolve(audio);
    });

    // Piper reads one line of text per utterance from stdin.
    child.stdin.write(`${text.replace(/\s+/g, " ").trim()}\n`);
    child.stdin.end();
  });
}
