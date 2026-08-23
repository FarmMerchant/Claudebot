/**
 * Kokoro TTS — an 82M-parameter model that runs locally on the CPU, no API key
 * and nothing metered. Voices are chosen by name (see `npm run voices`) and the
 * weights ship inside the npm package, so there is nothing to install by hand.
 *
 * The model is loaded once and kept warm: the first load takes several seconds
 * and we do not want that landing on the first question of the session.
 */

import { KokoroTTS, TextSplitterStream, type GenerateOptions } from "kokoro-js";
import { config, DISCORD_SAMPLE_RATE } from "./config.js";
import { floatToPcm16, monoToStereo, resampleMono } from "./audio.js";

/** Kokoro always renders at 24 kHz mono. */
const KOKORO_SAMPLE_RATE = 24_000;
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

type VoiceId = NonNullable<GenerateOptions["voice"]>;

let model: Promise<KokoroTTS> | null = null;

function load(): Promise<KokoroTTS> {
  model ??= KokoroTTS.from_pretrained(MODEL_ID, {
    // Counter-intuitively, q8 benchmarks ~3x slower than fp32 on a desktop CPU
    // — the int8 kernels aren't worth their dequantisation cost here.
    dtype: config.kokoroDtype,
    device: "cpu",
  });
  return model;
}

/**
 * Fail loudly on a misspelt KOKORO_VOICE, listing what was actually on offer,
 * rather than throwing once per answer for the rest of the session.
 */
function voiceId(tts: KokoroTTS, requested?: string): VoiceId {
  const wanted = requested || config.kokoroVoice;
  if (!Object.hasOwn(tts.voices, wanted)) {
    const names = Object.keys(tts.voices).join(", ");
    throw new Error(`KOKORO_VOICE=${wanted} is not a voice. Try one of: ${names}`);
  }
  return wanted as VoiceId;
}

/** Load the weights and run one throwaway pass so the first answer isn't slow. */
export async function warmKokoro(): Promise<void> {
  const tts = await load();
  await tts.generate("Ready.", {
    voice: voiceId(tts),
    speed: config.kokoroSpeed,
  });
}

export async function kokoroSynthesize(text: string, voice?: string): Promise<Buffer> {
  const tts = await load();
  const audio = await tts.generate(text, {
    voice: voiceId(tts, voice),
    speed: config.kokoroSpeed,
  });

  const mono = floatToPcm16(audio.audio);
  const rate = audio.sampling_rate ?? KOKORO_SAMPLE_RATE;
  return monoToStereo(resampleMono(mono, rate, DISCORD_SAMPLE_RATE));
}

/** Every voice the model ships with, for the `npm run voices` listing. */
export async function kokoroVoices(): Promise<Record<string, unknown>> {
  const tts = await load();
  return tts.voices as Record<string, unknown>;
}

/**
 * Same as kokoroSynthesize, but yields one buffer per sentence as it is
 * rendered. The caller can start playing sentence one while sentence two is
 * still being generated, which is most of the latency win available here.
 */
export async function* kokoroStream(
  text: string,
  voice?: string,
): AsyncGenerator<Buffer> {
  const tts = await load();

  // Passing a bare string makes kokoro-js build a splitter it never closes,
  // so the iterator waits forever for more text. Drive the splitter here and
  // close it ourselves so the stream actually ends.
  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();

  const stream = tts.stream(splitter, {
    voice: voiceId(tts, voice),
    speed: config.kokoroSpeed,
  });

  for await (const { audio } of stream) {
    const mono = floatToPcm16(audio.audio);
    const rate = audio.sampling_rate ?? KOKORO_SAMPLE_RATE;
    yield monoToStereo(resampleMono(mono, rate, DISCORD_SAMPLE_RATE));
  }
}
