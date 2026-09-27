// A small, fixed set of 7-band graphic-EQ presets. Frequencies are the
// center of each peaking filter band (Hz); gains are dB. The client applies
// these live via Web Audio BiquadFilterNodes — nothing here touches files.
export const EQ_BANDS_HZ = [60, 150, 400, 1000, 2400, 6000, 15000];

export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0],
  bass_boost: [6, 5, 3, 0, -1, -1, 0],
  treble_boost: [-1, -1, 0, 1, 3, 5, 6],
  vocal_boost: [-2, -1, 1, 4, 4, 1, -1],
  jazz: [3, 2, 0, 1, 2, 3, 3],
  rock: [4, 2, -2, -3, 0, 3, 4],
  pop: [-1, 2, 4, 4, 1, -1, -2],
  classical: [3, 2, 0, 0, -1, 2, 3],
  electronic: [4, 3, 0, -2, 1, 2, 4],
  hiphop: [5, 4, 1, -1, 1, 0, 2],
  acoustic: [3, 2, 1, 0, 1, 2, 2],
  loudness: [5, 3, 0, 0, 0, 2, 4],
};

export const EQ_PRESET_LABELS = {
  flat: 'Flat (off)', bass_boost: 'Bass Boost', treble_boost: 'Treble Boost', vocal_boost: 'Vocal Boost',
  jazz: 'Jazz', rock: 'Rock', pop: 'Pop', classical: 'Classical', electronic: 'Electronic',
  hiphop: 'Hip-Hop', acoustic: 'Acoustic', loudness: 'Loudness', custom: 'Custom',
};

export const isValidBands = (b) => Array.isArray(b) && b.length === EQ_BANDS_HZ.length && b.every((n) => typeof n === 'number' && isFinite(n) && n >= -12 && n <= 12);
