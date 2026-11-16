// The doorbell's own sound: a two-note ding-dong, made here instead of shipped
// as a file. Sonos plays audio clips from a web address, and only MP3 or WAV,
// so the Worker serves this as a WAV at DINGDONG_PATH.

const RATE = 44_100;
const SECONDS = 2.6;

/**
 * One struck note, added into `out`. A fundamental and a few quieter partials,
 * each dying away, the higher ones sooner: roughly a chime bar.
 */
function strike(out: Float32Array, startSec: number, freq: number): void {
  const partials: [ratio: number, amp: number, decaySec: number][] = [
    [1, 1, 1.1],
    [2, 0.35, 0.55],
    [3, 0.12, 0.3],
    [4.2, 0.05, 0.18],
  ];
  const s0 = Math.round(startSec * RATE);
  for (let i = 0; s0 + i < out.length; i++) {
    const t = i / RATE;
    // A few milliseconds of attack, so the note starts without a click.
    let v = 0;
    for (const [ratio, amp, decay] of partials) v += amp * Math.exp(-t / decay) * Math.sin(2 * Math.PI * freq * ratio * t);
    out[s0 + i]! += Math.min(1, t / 0.004) * v;
  }
}

function wav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per sample
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true);
  }
  return bytes;
}

let made: Uint8Array | null = null;

/** The ding-dong as a WAV file: E then C, a major third down, like a classic two-note bell. */
export function dingDong(): Uint8Array {
  if (made) return made;
  const out = new Float32Array(Math.round(SECONDS * RATE));
  strike(out, 0, 659.25);
  strike(out, 0.6, 523.25);
  // Fade the last quarter second to silence, then bring the loudest moment to 85%.
  const tail = Math.round(0.25 * RATE);
  for (let i = 0; i < tail; i++) out[out.length - 1 - i]! *= i / tail;
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  for (let i = 0; i < out.length; i++) out[i]! *= 0.85 / peak;
  return (made = wav(out));
}
