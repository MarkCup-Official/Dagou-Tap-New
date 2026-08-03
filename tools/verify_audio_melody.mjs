import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AudioMelody = require('../audio-melody.js');

const sampleRate = 12000;
const sections = [
  { frequency: 440, duration: 0.52 },
  { frequency: 0, duration: 0.20 },
  { frequency: 523.251, duration: 0.56 },
];
const samples = new Float32Array(
  Math.ceil(sections.reduce((sum, section) => sum + section.duration, 0) * sampleRate)
);
let cursor = 0;
for (const section of sections) {
  const frames = Math.floor(section.duration * sampleRate);
  for (let i = 0; i < frames; i++) {
    const envelope = Math.min(1, i / 120, (frames - i - 1) / 120);
    samples[cursor + i] = section.frequency
      ? Math.sin(2 * Math.PI * section.frequency * i / sampleRate) * 0.7 * Math.max(0, envelope)
      : 0;
  }
  cursor += frames;
}

const analysed = await AudioMelody.analyzeSamples(samples, sampleRate);
assert.ok(analysed.notes.length >= 2, 'two sung notes should be detected');
assert.ok(
  analysed.notes.some(note => Math.abs(note.midiNote - 69) <= 1),
  'A4 should be detected'
);
assert.ok(
  analysed.notes.some(note => Math.abs(note.midiNote - 72) <= 1),
  'C5 should be detected'
);
assert.ok(
  analysed.notes.every(note => note.duration >= 0.12),
  'micro-pitch fragments should be removed'
);
assert.equal(Math.round(AudioMelody.frequencyToMidi(440)), 69);

console.log('Audio melody verification passed:');
console.log(`- detected ${analysed.notes.length} stable notes`);
console.log('- A4, silence, and C5 segmentation is preserved');

const mixedSeconds = 3;
const mixed = new Float32Array(mixedSeconds * sampleRate);
let noiseSeed = 0x12345678;
const deterministicNoise = () => {
  noiseSeed = (Math.imul(noiseSeed, 1664525) + 1013904223) >>> 0;
  return noiseSeed / 0x100000000 * 2 - 1;
};
for (let i = 0; i < mixed.length; i++) {
  const time = i / sampleRate;
  const melody = time < 1.5 ? 440 : 523.251;
  mixed[i] =
    Math.sin(2 * Math.PI * melody * time) * 0.16 +
    Math.sin(2 * Math.PI * 82.407 * time) * 0.48 +
    Math.sin(2 * Math.PI * 164.814 * time) * 0.22 +
    (i % 1200 < 45 ? deterministicNoise() * 0.3 : 0);
}
const mixedResult = await AudioMelody.analyzeSamples(mixed, sampleRate, {
  spectralFallbackCoverage: 1,
});
assert.equal(mixedResult.method, 'spectral');
assert.ok(
  mixedResult.notes.some(note => Math.abs(note.midiNote - 69) <= 1),
  'spectral fallback should recover A4 above stronger bass'
);
assert.ok(
  mixedResult.notes.some(note => Math.abs(note.midiNote - 72) <= 1),
  'spectral fallback should recover C5 above stronger bass'
);
console.log('- spectral fallback recovers melody over stronger bass and transients');
