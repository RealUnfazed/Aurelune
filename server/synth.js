// Tiny offline synthesizer: turns a few musical parameters into a WAV file, so a fresh install
// has real, playable audio without shipping any copyrighted music.

const SR = 22050;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  pent: [0, 3, 5, 7, 10],
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} o  { seed, seconds, bpm, root (midi), scale, beat (bool), arp (bool), pad (0..1) }
 * @returns {Buffer} 16-bit mono PCM WAV
 */
export function synthWav(o) {
  const { seed = 1, seconds = 36, bpm = 90, root = 57, scale = 'minor', beat = true, arp = true, pad = 0.6 } = o;
  const r = rng(seed);
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const sc = SCALES[scale] || SCALES.minor;
  const beatLen = (60 / bpm) * SR;
  const degree = (d, oct = 0) => root + sc[((d % sc.length) + sc.length) % sc.length] + 12 * (Math.floor(d / sc.length) + oct);

  // chord progression: one chord per 4 beats, degrees chosen from the seed
  const prog = [0, 5, 3, 4].map((d) => (d + Math.floor(r() * 2)) % sc.length);
  const chordAt = (b) => prog[Math.floor(b / 4) % prog.length];

  // pad: soft detuned sines with slow swell each chord
  for (let i = 0; i < n; i++) {
    const b = i / beatLen;
    const d = chordAt(b);
    const pos = (b % 4) / 4;
    const env = Math.min(1, pos * 5) * (0.55 + 0.45 * Math.cos(pos * Math.PI));
    let s = 0;
    for (const k of [0, 2, 4]) {
      const f = midi(degree(d + k, 0));
      s += Math.sin(2 * Math.PI * f * (i / SR)) + 0.5 * Math.sin(2 * Math.PI * f * 1.004 * (i / SR)) + 0.25 * Math.sin(2 * Math.PI * f * 2 * (i / SR));
    }
    out[i] += (s / 9) * env * pad * 0.9;
  }

  // bass: root on every beat
  for (let bt = 0; bt * beatLen < n; bt++) {
    const start = Math.floor(bt * beatLen);
    const f = midi(degree(chordAt(bt), -2));
    const len = Math.floor(beatLen * 0.9);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR;
      out[start + i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 4.5) * 0.42;
    }
  }

  // arpeggio: plucked eighth notes
  if (arp) {
    for (let e = 0; e * (beatLen / 2) < n; e++) {
      const start = Math.floor(e * (beatLen / 2));
      const d = chordAt(e / 2);
      const pattern = [0, 2, 4, 7, 4, 2, 5, 2];
      const note = degree(d + pattern[e % pattern.length] + (r() < 0.12 ? 1 : 0), 1);
      const f = midi(note);
      const len = Math.floor(beatLen * 0.8);
      for (let i = 0; i < len && start + i < n; i++) {
        const t = i / SR;
        const env = Math.exp(-t * 7);
        out[start + i] += (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 3 * t) * Math.exp(-t * 14)) * env * 0.16;
      }
    }
  }

  // drums
  if (beat) {
    for (let bt = 0; bt * beatLen < n; bt++) {
      const start = Math.floor(bt * beatLen);
      if (bt % 2 === 0) for (let i = 0; i < SR * 0.22 && start + i < n; i++) { // kick
        const t = i / SR;
        out[start + i] += Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-t * 28)) * t) * Math.exp(-t * 11) * 0.55;
      }
      const off = start + Math.floor(beatLen / 2); // hat on the off-beat
      for (let i = 0; i < SR * 0.05 && off + i < n; i++) out[off + i] += (r() * 2 - 1) * Math.exp(-(i / SR) * 70) * 0.07;
    }
  }

  // cheap reverb: two feedback delays
  const delays = [Math.floor(SR * 0.23), Math.floor(SR * 0.37)];
  for (const d of delays) for (let i = d; i < n; i++) out[i] += out[i - d] * 0.28;

  // fades, normalise, one-pole low-pass to keep it warm
  let peak = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const fadeIn = Math.min(1, i / (SR * 1.2)), fadeOut = Math.min(1, (n - i) / (SR * 2.5));
    lp += (out[i] - lp) * 0.55;
    out[i] = lp * fadeIn * fadeOut;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const g = peak ? 0.85 / peak : 1;

  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  return data;
}
