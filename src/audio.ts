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

/** Interleaved stereo resample — de-interleave, resample each side, re-interleave. */
export function resampleStereo(stereo: Buffer, from: number, to: number): Buffer {
  if (from === to) return stereo;

  const frames = Math.floor(stereo.length / 4);
  const left = Buffer.allocUnsafe(frames * 2);
  const right = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    left.writeInt16LE(stereo.readInt16LE(i * 4), i * 2);
    right.writeInt16LE(stereo.readInt16LE(i * 4 + 2), i * 2);
  }

  const l = resampleMono(left, from, to);
  const r = resampleMono(right, from, to);
  const outFrames = Math.floor(Math.min(l.length, r.length) / 2);

  const out = Buffer.allocUnsafe(outFrames * 4);
  for (let i = 0; i < outFrames; i++) {
    out.writeInt16LE(l.readInt16LE(i * 2), i * 4);
    out.writeInt16LE(r.readInt16LE(i * 2), i * 4 + 2);
  }
  return out;
}

export interface WavAudio {
  /** Interleaved 16-bit signed little-endian, whatever the source depth was. */
  pcm: Buffer;
  sampleRate: number;
  channels: number;
}

/**
 * Minimal RIFF/WAVE reader for the outburst sound files. Handles the integer
 * and float depths a sound library is likely to hand you and normalises all of
 * them to 16-bit, because that is the only thing the voice connection takes.
 */
export function decodeWav(file: Buffer): WavAudio {
  if (
    file.length < 12 ||
    file.toString("latin1", 0, 4) !== "RIFF" ||
    file.toString("latin1", 8, 12) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;

  // fmt and data can be separated by other chunks (LIST, fact, ...), so walk
  // the whole list rather than assuming the canonical 44-byte layout.
  let offset = 12;
  while (offset + 8 <= file.length) {
    const id = file.toString("latin1", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt " && size >= 16) {
      format = file.readUInt16LE(body);
      channels = file.readUInt16LE(body + 2);
      sampleRate = file.readUInt32LE(body + 4);
      bits = file.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE keeps the real tag in the first two bytes of
      // its SubFormat GUID — common for 24-bit files out of a DAW.
      if (format === 0xfffe && size >= 40) format = file.readUInt16LE(body + 24);
    } else if (id === "data") {
      // Some writers leave the size field short or overlong; trust the file.
      data = file.subarray(body, Math.min(body + size, file.length));
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!data) throw new Error("no data chunk");
  if (!sampleRate || !channels) throw new Error("no fmt chunk");

  const bytes = bits / 8;
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new Error(`odd bit depth (${bits})`);
  }

  const total = Math.floor(data.length / bytes);
  const pcm = Buffer.allocUnsafe(total * 2);

  for (let i = 0; i < total; i++) {
    const at = i * bytes;
    let sample: number;

    if (format === 3) {
      // IEEE float, nominally -1..1 but not guaranteed — clamp before scaling.
      const value = bits === 64 ? data.readDoubleLE(at) : data.readFloatLE(at);
      sample = Math.round(Math.max(-1, Math.min(1, value)) * 32_767);
    } else if (bits === 8) {
      sample = (data.readUInt8(at) - 128) * 256; // 8-bit WAV is unsigned
    } else if (bits === 16) {
      sample = data.readInt16LE(at);
    } else if (bits === 24) {
      sample = data.readIntLE(at, 3) >> 8;
    } else if (bits === 32) {
      sample = data.readInt32LE(at) >> 16;
    } else {
      throw new Error(`unsupported format ${format} at ${bits}-bit`);
    }

    pcm.writeInt16LE(Math.max(-32_768, Math.min(32_767, sample)), i * 2);
  }

  return { pcm, sampleRate, channels };
}
