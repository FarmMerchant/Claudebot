/**
 * Procedurally generated nonsense noises for the random outbursts.
 *
 * These are synthesised from scratch rather than shipped as audio files —
 * nothing to download, nothing to license, and every utterance comes out
 * slightly different. Output is 48 kHz 16-bit stereo, ready for the voice
 * connection exactly like Piper's output is.
 */

import { DISCORD_SAMPLE_RATE as SR } from "./config.js";
import { monoToStereo } from "./audio.js";

const TWO_PI = Math.PI * 2;

/** One-pole low-pass. Crude, but it's the difference between a buzz and a rasp. */
function lowpass(cutoffHz: number): (x: number) => number {
  const a = 1 - Math.exp((-TWO_PI * cutoffHz) / SR);
  let y = 0;
  return (x) => (y += a * (x - y));
}

/**
 * Float samples -> 16-bit LE mono. Anything over unity gets soft-clipped, so
 * driving the generators hard distorts like an overloaded speaker instead of
 * wrapping around into digital noise.
 */
function toPcm(samples: Float32Array): Buffer {
  const pcm = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    pcm.writeInt16LE(Math.round(Math.tanh(samples[i]) * 32_700), i * 2);
  }
  return pcm;
}

function seconds(count: number): number {
  return Math.floor(count * SR);
}

/**
 * A very loud fart. A pulse wave sagging in pitch, amplitude-modulated by a
 * flutter that speeds up as it goes — that flutter is the whole effect; a
 * steady tone at these frequencies just sounds like a bass note.
 */
export function fart(): Buffer {
  const n = seconds(0.55 + Math.random() * 0.7);
  const out = new Float32Array(n);

  const startHz = 95 + Math.random() * 55;
  const endHz = 45 + Math.random() * 30;
  const flutterHz = 17 + Math.random() * 15;
  const duty = 0.22 + Math.random() * 0.18;
  const body = lowpass(1500);

  let phase = 0;
  let flutterPhase = 0;

  for (let i = 0; i < n; i++) {
    const t = i / n;

    phase = (phase + (startHz + (endHz - startHz) * t) / SR) % 1;
    // Narrow pulse + saw: harmonically rich enough to sound wet rather than musical.
    const pulse = phase < duty ? 1 : -1;
    const saw = 2 * phase - 1;
    const noise = (Math.random() * 2 - 1) * 0.35;

    // The sputter tightens up towards the end, the way the real thing does.
    flutterPhase = (flutterPhase + (flutterHz * (1 + 1.1 * t)) / SR) % 1;
    const flutter = 0.5 + 0.5 * Math.sin(TWO_PI * flutterPhase);

    const attack = Math.min(1, i / seconds(0.008));
    const decay = (1 - t) ** 1.5;

    out[i] = body(pulse * 0.6 + saw * 0.4 + noise) * flutter * attack * decay * 4;
  }

  return monoToStereo(toPcm(out));
}

/**
 * An unspecified guttural noise — a growl, a groan, something clearing a throat
 * that it does not have. Sawtooth in the vocal-fry range, wobbled by vibrato and
 * chopped by a tremolo fast enough to read as a rattle.
 */
export function guttural(): Buffer {
  const n = seconds(0.5 + Math.random() * 1);
  const out = new Float32Array(n);

  const baseHz = 68 + Math.random() * 55;
  const drift = 0.75 + Math.random() * 0.5; // where the pitch ends up, relative
  const vibratoHz = 4.5 + Math.random() * 4;
  const rattleHz = 11 + Math.random() * 20;
  const throat = lowpass(650 + Math.random() * 500);
  const chest = lowpass(180);

  let phase = 0;
  let vibratoPhase = 0;
  let rattlePhase = 0;

  for (let i = 0; i < n; i++) {
    const t = i / n;

    vibratoPhase = (vibratoPhase + vibratoHz / SR) % 1;
    const hz =
      baseHz * (1 + (drift - 1) * t) * (1 + 0.09 * Math.sin(TWO_PI * vibratoPhase));
    phase = (phase + hz / SR) % 1;

    const saw = 2 * phase - 1;
    const noise = (Math.random() * 2 - 1) * 0.2;

    rattlePhase = (rattlePhase + rattleHz / SR) % 1;
    const rattle = 0.45 + 0.55 * Math.abs(Math.sin(TWO_PI * rattlePhase));

    const attack = Math.min(1, i / seconds(0.06));
    const release = Math.min(1, (1 - t) / 0.25);

    const voice = throat(saw + noise);
    out[i] = (voice + chest(saw) * 0.8) * rattle * attack * release * 0.85;
  }

  return monoToStereo(toPcm(out));
}
