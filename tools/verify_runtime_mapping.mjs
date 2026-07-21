#!/usr/bin/env node

// Executes the actual pitch-mapping declarations/functions extracted from
// main.js, then compares every fixed sample/tier rate with the analyzer report.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(toolsDir);
const mainPath = path.join(rootDir, 'main.js');
const audioDataPath = path.join(rootDir, 'audio-data.js');
const reportPath = path.join(toolsDir, 'tmp', 'pitch-analysis-report.json');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const sampleNames = [
  'da', 'gou', 'jiao',
  'ha', 'ji', 'mi',
  'dingdongji_ding', 'dingdongji_dong', 'dingdongji_ji',
];
const runtimeSampleFiles = {
  da: 'da.wav',
  gou: 'gou.wav',
  jiao: 'jiao.wav',
  ha: 'ha_new.wav',
  ji: 'ji_new.wav',
  mi: 'mi_new.wav',
  dingdongji_ding: 'dingdongji_ding.wav',
  dingdongji_dong: 'dingdongji_dong.wav',
  dingdongji_ji: 'dingdongji_ji.wav',
};

function extractDeclaration(pattern, label) {
  const match = mainSource.match(pattern);
  if (!match) throw new Error(`Cannot find ${label} in main.js`);
  return match[0];
}

function extractFunction(name) {
  const start = mainSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Cannot find function ${name} in main.js`);
  const bodyStart = mainSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainSource.length; index++) {
    if (mainSource[index] === '{') depth++;
    if (mainSource[index] === '}') {
      depth--;
      if (depth === 0) return mainSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed function ${name} in main.js`);
}

const declarations = [
  extractDeclaration(
    /const SUSTAIN_REGIONS = \{[\s\S]*?\n\};/,
    'SUSTAIN_REGIONS',
  ),
  extractDeclaration(
    /const SFX_SAMPLE_SETS = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'SFX_SAMPLE_SETS',
  ),
  extractDeclaration(
    /const BARK_SOURCE_MIDI = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'BARK_SOURCE_MIDI',
  ),
  extractDeclaration(
    /const BARK_TARGET_MIDI = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'BARK_TARGET_MIDI',
  ),
  extractDeclaration(
    /const PIANO_SCALE = Object\.freeze\(\[[\s\S]*?\n\]\);/,
    'PIANO_SCALE',
  ),
  extractDeclaration(
    /const SFX_SAMPLE_GAIN = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'SFX_SAMPLE_GAIN',
  ),
].join('\n');

const runtimeRateFunction = extractFunction('barkPlaybackRate');
const resolveSfxSampleFunction = extractFunction('resolveSfxSample');
if (!/^function barkPlaybackRate\(sample, pitchTier, fixedTargetMidi\)/.test(runtimeRateFunction)) {
  throw new Error('barkPlaybackRate must accept a fixed piano target MIDI override');
}

const sandbox = {};
vm.runInNewContext(
  `
  let cols = 4;
  let rows = 3;
  let zones = [];
  let selectedSfxId = 'dagou';
  const performanceSettings = { pianoMode: false };
  let stageMetrics = { width: 1200, height: 800 };
  function getStageMetrics() { return stageMetrics; }
  ${declarations}
  ${runtimeRateFunction}
  ${resolveSfxSampleFunction}
  ${extractFunction('buildGrid')}
  globalThis.mappingApi = {
    barkPlaybackRate,
    sustainRegions: SUSTAIN_REGIONS,
    sourceMidi: BARK_SOURCE_MIDI,
    targetMidi: BARK_TARGET_MIDI,
    pianoScale: PIANO_SCALE,
    sampleGain: SFX_SAMPLE_GAIN,
    resolveSfxSample,
    buildLayout(width, height, pianoMode = false) {
      stageMetrics = { width, height };
      performanceSettings.pianoMode = pianoMode;
      buildGrid();
      return {
        cols,
        rows,
        zones: zones.map(zone => ({ ...zone })),
      };
    },
  };
  `,
  sandbox,
);

const { mappingApi } = sandbox;
const expectedSfxSamples = {
  hajimi: { da: 'ha', gou: 'ji', jiao: 'mi' },
  dingdong: {
    da: 'dingdongji_ding',
    gou: 'dingdongji_dong',
    jiao: 'dingdongji_ji',
  },
};
const analysedMiSustain = report.sustain_regions?.mi;
if (!analysedMiSustain?.config) {
  throw new Error('Pitch analyzer report is missing the mi sustain-region audit');
}
for (const [key, expected] of Object.entries(analysedMiSustain.config)) {
  if (mappingApi.sustainRegions.mi?.[key] !== expected) {
    throw new Error(
      `mi sustain ${key}: expected ${expected}, got ` +
      `${mappingApi.sustainRegions.mi?.[key]}`,
    );
  }
}
if (
  analysedMiSustain.pitch_span_cents > 30 ||
  analysedMiSustain.rms_span_db > 4 ||
  analysedMiSustain.minimum_confidence < 0.8
) {
  throw new Error('mi sustain region is not stable enough for WSOLA looping');
}
for (const [sfxId, expectedSamples] of Object.entries(expectedSfxSamples)) {
  for (const [semanticSample, audioSample] of Object.entries(expectedSamples)) {
    if (mappingApi.resolveSfxSample(semanticSample, sfxId) !== audioSample) {
      throw new Error(`${sfxId} ${semanticSample} must resolve to ${audioSample}`);
    }
    if (mappingApi.resolveSfxSample(semanticSample, 'dagou') !== semanticSample) {
      throw new Error(`Dagou ${semanticSample} must remain unchanged`);
    }
  }
}

const audioSandbox = {};
vm.runInNewContext(
  fs.readFileSync(audioDataPath, 'utf8').replace(
    'const AUDIO_B64',
    'globalThis.AUDIO_B64',
  ),
  audioSandbox,
);
for (const sample of sampleNames) {
  if (!audioSandbox.AUDIO_B64?.[sample]) {
    throw new Error(`Embedded audio bundle is missing ${sample}`);
  }
  const runtimeFile = path.join(
    rootDir,
    'audio',
    ...runtimeSampleFiles[sample].split('/'),
  );
  const embedded = Buffer.from(audioSandbox.AUDIO_B64[sample], 'base64');
  if (!embedded.equals(fs.readFileSync(runtimeFile))) {
    throw new Error(`Embedded ${sample} does not match ${runtimeSampleFiles[sample]}`);
  }
}

let checked = 0;
if (!Array.isArray(report.mappings) || report.mappings.length !== 36) {
  throw new Error('Pitch analyzer report must contain all 36 normal sample/tier mappings');
}
for (const mapping of report.mappings) {
  const actualRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.tier_index,
  );
  if (Math.abs(actualRate - mapping.playback_rate) > 1e-10) {
    throw new Error(
      `${mapping.sample}/${mapping.tier}: ` +
      `expected ${mapping.playback_rate}, got ${actualRate}`,
    );
  }
  // Repeated calls must never alter a key's pitch.
  const repeatedRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.tier_index,
  );
  if (repeatedRate !== actualRate) {
    throw new Error(`${mapping.sample}/${mapping.tier}: rate is not stable`);
  }
  checked++;
}

const minorPentatonicPitchClasses = new Set([9, 0, 2, 4, 7]);
for (const sample of sampleNames) {
  const rows = report.mappings
    .filter(item => item.sample === sample)
    .sort((left, right) => left.tier_index - right.tier_index);
  if (rows.length !== 4) {
    throw new Error(`${sample}: expected four fixed pitch keys`);
  }
  for (const row of rows) {
    if (!minorPentatonicPitchClasses.has(row.target_midi % 12)) {
      throw new Error(`${sample}/${row.tier}: target is outside A minor pentatonic`);
    }
    if (mappingApi.targetMidi[sample][row.tier_index] !== row.target_midi) {
      throw new Error(`${sample}/${row.tier}: runtime target MIDI mismatch`);
    }
  }

  const sourceMidi = mappingApi.sourceMidi[sample];
  const candidates = [];
  for (let midi = 24; midi <= 108; midi++) {
    if (minorPentatonicPitchClasses.has(midi % 12)) candidates.push(midi);
  }
  const nearest = candidates.reduce((best, midi) =>
    Math.abs(midi - sourceMidi) < Math.abs(best - sourceMidi) ? midi : best
  );
  if (rows[2].target_midi !== nearest) {
    throw new Error(
      `${sample}: tier 3 is ${rows[2].target_midi}, nearest minor note is ${nearest}`,
    );
  }
}

const landscape = mappingApi.buildLayout(1200, 800);
if (landscape.cols !== 4 || landscape.rows !== 3) {
  throw new Error('Landscape grid is not 4 columns × 3 rows');
}
for (let row = 0; row < 3; row++) {
  const rowZones = landscape.zones.slice(row * 4, row * 4 + 4);
  if (rowZones.some((zone, column) => zone.pitchTier !== column)) {
    throw new Error(`Landscape row ${row}: pitch tiers do not run 0,1,2,3`);
  }
  if (rowZones[2].pitchTier !== 2) {
    throw new Error(`Landscape row ${row}: nearest-minor key is not in column 3`);
  }
}

const portrait = mappingApi.buildLayout(800, 1200);
if (portrait.cols !== 3 || portrait.rows !== 4) {
  throw new Error('Portrait grid is not 3 columns × 4 rows');
}
for (let row = 0; row < 4; row++) {
  const rowZones = portrait.zones.slice(row * 3, row * 3 + 3);
  if (rowZones.some(zone => zone.pitchTier !== row)) {
    throw new Error(`Portrait row ${row}: pitch tier does not match row`);
  }
}
if (portrait.zones.slice(6, 9).some(zone => zone.pitchTier !== 2)) {
  throw new Error('Portrait nearest-minor keys are not in row 3');
}

const pianoMidi = [60, 62, 64, 65, 67, 69, 71, 72];
if (!Array.isArray(report.piano_mappings) || report.piano_mappings.length !== 72) {
  throw new Error('Pitch analyzer report must contain all 72 piano sample/key mappings');
}
for (const mapping of report.piano_mappings) {
  if (pianoMidi[mapping.key_index] !== mapping.target_midi) {
    throw new Error(`${mapping.sample}/piano-${mapping.key_index}: report target mismatch`);
  }
  if (mappingApi.pianoScale[mapping.key_index].midi !== mapping.target_midi) {
    throw new Error(`${mapping.sample}/piano-${mapping.key_index}: runtime scale mismatch`);
  }
  const actualRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.key_index,
    mapping.target_midi,
  );
  if (Math.abs(actualRate - mapping.playback_rate) > 1e-10) {
    throw new Error(
      `${mapping.sample}/piano-${mapping.key_index}: ` +
      `expected ${mapping.playback_rate}, got ${actualRate}`,
    );
  }
}

const pianoLandscape = mappingApi.buildLayout(1200, 800, true);
if (pianoLandscape.cols !== 8 || pianoLandscape.rows !== 3) {
  throw new Error('Piano landscape grid is not 8 columns × 3 rows');
}
for (let row = 0; row < 3; row++) {
  const rowZones = pianoLandscape.zones.slice(row * 8, row * 8 + 8);
  const actualMidi = rowZones.map(zone => zone.targetMidi);
  if (actualMidi.some((midi, index) => midi !== pianoMidi[index])) {
    throw new Error(`Piano landscape row ${row}: C4–C5 order is incorrect`);
  }
  const expectedSample = ['da', 'gou', 'jiao'][row];
  if (rowZones.some(zone => zone.sample !== expectedSample)) {
    throw new Error(`Piano landscape row ${row}: sample mapping is incorrect`);
  }
}

const pianoPortrait = mappingApi.buildLayout(800, 1200, true);
if (pianoPortrait.cols !== 3 || pianoPortrait.rows !== 8) {
  throw new Error('Piano portrait grid is not 3 columns × 8 rows');
}
for (let row = 0; row < 8; row++) {
  const rowZones = pianoPortrait.zones.slice(row * 3, row * 3 + 3);
  const expectedMidi = pianoMidi[7 - row];
  if (rowZones.some(zone => zone.targetMidi !== expectedMidi)) {
    throw new Error(`Piano portrait row ${row}: descending pitch is incorrect`);
  }
  if (rowZones.some((zone, column) => zone.sample !== ['da', 'gou', 'jiao'][column])) {
    throw new Error(`Piano portrait row ${row}: sample mapping is incorrect`);
  }
}

for (const sample of sampleNames) {
  for (const targetMidi of pianoMidi) {
    const expectedRate = 2 ** ((targetMidi - mappingApi.sourceMidi[sample]) / 12);
    const actualRate = mappingApi.barkPlaybackRate(sample, 0, targetMidi);
    if (Math.abs(actualRate - expectedRate) > 1e-12) {
      throw new Error(`${sample}/${targetMidi}: piano playback rate is imprecise`);
    }
  }
}

for (const sample of sampleNames) {
  const expectedGain = report.loudness?.sample_gain?.[sample];
  if (!Number.isFinite(expectedGain)) {
    throw new Error(`${sample}: analyzer report is missing loudness gain`);
  }
  if (Math.abs(mappingApi.sampleGain[sample] - expectedGain) > 1e-9) {
    throw new Error(
      `${sample}: expected loudness gain ${expectedGain}, ` +
      `got ${mappingApi.sampleGain[sample]}`,
    );
  }
}
if (report.worst_transposed_loudness_error_db > 1) {
  throw new Error('Normal-mode loudness calibration exceeds 1 dB');
}
if (report.worst_piano_loudness_error_db > 1) {
  throw new Error('Piano-mode loudness calibration exceeds 1 dB');
}

console.log(`Runtime fixed pitch mapping verified: ${checked} sample/tier keys`);
console.log('SFX routing verified: Hajimi and Dingdong replace all three samples');
console.log('Embedded audio verified: all nine runtime WAV files are present');
console.log(
  `Hajimi mi sustain verified: ` +
  `${analysedMiSustain.pitch_span_cents.toFixed(3)} cents pitch span, ` +
  `${analysedMiSustain.rms_span_db.toFixed(3)} dB level span`,
);
console.log('Repeated-key pitch stability verified: no chord/time-dependent switching');
console.log('Layout verified: column 3 / row 3 use the nearest minor-pentatonic note');
console.log('Piano layout verified: 8 × 3 C4–C5 scale and reversed 3 × 8 portrait scale');
console.log(
  `Worst remeasured transposed error: ` +
  `${report.worst_transposed_target_error_cents.toFixed(3)} cents`,
);
console.log(
  `Worst remeasured piano error: ` +
  `${report.worst_piano_target_error_cents.toFixed(3)} cents`,
);
console.log(
  `Worst calibrated loudness error: ` +
  `${Math.max(
    report.worst_transposed_loudness_error_db,
    report.worst_piano_loudness_error_db,
  ).toFixed(3)} dB`,
);
