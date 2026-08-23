/**
 * PCM plumbing between Discord (48 kHz stereo), whisper.cpp (16 kHz mono WAV)
 * and Piper (mono at whatever rate the voice model was trained at).
 * All buffers here are 16-bit signed little-endian.
 */

/** Average the channel pair down to one. */
export function stereoToMono(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4);
  const mono = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    const mixed =
      (stereo.readInt16LE(i * 4) + stereo.readInt16LE(i * 4 + 2)) / 2;
    mono.writeInt16LE(mixed | 0, i * 2);
  }
  return mono;
}

/** Duplicate the single channel — the voice connection wants interleaved stereo. */
export function monoToStereo(mono: Buffer): Buffer {
  const samples = Math.floor(mono.length / 2);
  const stereo = Buffer.allocUnsafe(samples * 4);
  for (let i = 0; i < samples; i++) {
    const sample = mono.readInt16LE(i * 2);
    stereo.writeInt16LE(sample, i * 4);
    stereo.writeInt16LE(sample, i * 4 + 2);
  }
  return stereo;
}

/**
 * Box-average whole blocks of samples. Used for the 48k -> 16k path, where the
 * averaging doubles as the anti-alias filter that plain decimation would skip.
 */
function decimate(mono: Buffer, factor: number): Buffer {
  const samples = Math.floor(mono.length / 2);
  const outSamples = Math.floor(samples / factor);
  const out = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += mono.readInt16LE((i * factor + j) * 2);
    out.writeInt16LE((sum / factor) | 0, i * 2);
  }
  return out;
}

/** Linear interpolation, for the non-integer ratios (e.g. Piper's 22050 -> 48000). */
function interpolate(mono: Buffer, from: number, to: number): Buffer {
  const inSamples = Math.floor(mono.length / 2);
  if (inSamples < 2) return mono;

  const outSamples = Math.max(1, Math.round((inSamples * to) / from));
  const out = Buffer.allocUnsafe(outSamples * 2);
  const step = (inSamples - 1) / Math.max(1, outSamples - 1);

  for (let i = 0; i < outSamples; i++) {
    const pos = i * step;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = mono.readInt16LE(index * 2);
    const b = index + 1 < inSamples ? mono.readInt16LE((index + 1) * 2) : a;
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
  }
  return out;
}

export function resampleMono(mono: Buffer, from: number, to: number): Buffer {
  if (from === to) return mono;
  if (from > to && from % to === 0) return decimate(mono, from / to);
  return interpolate(mono, from, to);
}

/** Wrap raw PCM in a 44-byte WAV header so whisper.cpp will read it. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function durationMs(pcm: Buffer, sampleRate: number, channels = 1): number {
  return (pcm.length / 2 / channels / sampleRate) * 1000;
}
