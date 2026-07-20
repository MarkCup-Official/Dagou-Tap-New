#!/usr/bin/env node

// Executes the actual pitch-mapping declarations/functions extracted from
// main.js, then compares every sample/chord/tier rate with the analyzer report.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(toolsDir);
const mainPath = path.join(rootDir, 'main.js');
const reportPath = path.join(toolsDir, 'tmp', 'pitch-analysis-report.json');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

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
  extractDeclaration(/const CHORDS = \[[\s\S]*?\n\];/, 'CHORDS'),
  extractDeclaration(
    /const BARK_SOURCE_MIDI = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'BARK_SOURCE_MIDI',
  ),
  extractDeclaration(
    /const ORIGINAL_PITCH_TIER = \d+;/,
    'ORIGINAL_PITCH_TIER',
  ),
].join('\n');

const sandbox = {};
vm.runInNewContext(
  `
  const S16 = 1;
  let startTime = 0;
  let cols = 4;
  let rows = 3;
  let zones = [];
  let stageMetrics = { width: 1200, height: 800 };
  function getStageMetrics() { return stageMetrics; }
  ${declarations}
  ${extractFunction('chordIndexAt')}
  ${extractFunction('barkPlaybackRate')}
  ${extractFunction('buildGrid')}
  globalThis.mappingApi = {
    chordIndexAt,
    barkPlaybackRate,
    sourceMidi: BARK_SOURCE_MIDI,
    buildLayout(width, height) {
      stageMetrics = { width, height };
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
let checked = 0;
for (const mapping of report.mappings) {
  const when = mapping.chord_index * 16;
  const actualChord = mappingApi.chordIndexAt(when);
  if (actualChord !== mapping.chord_index) {
    throw new Error(
      `Chord mismatch at ${when}: expected ${mapping.chord_index}, got ${actualChord}`,
    );
  }

  const actualRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.tier_index,
    when,
  );
  if (Math.abs(actualRate - mapping.playback_rate) > 1e-10) {
    throw new Error(
      `${mapping.chord}/${mapping.sample}/${mapping.tier}: ` +
      `expected ${mapping.playback_rate}, got ${actualRate}`,
    );
  }
  checked++;
}

for (const chord of ['C', 'G', 'Am', 'F']) {
  for (const sample of ['da', 'gou', 'jiao']) {
    const rows = report.mappings
      .filter(item => item.chord === chord && item.sample === sample)
      .sort((left, right) => left.tier_index - right.tier_index);
    const sourceMidi = mappingApi.sourceMidi[sample];
    const targetMidis = [
      rows[0].target_midi,
      rows[1].target_midi,
      sourceMidi,
      rows[3].target_midi,
    ];
    if (!(
      targetMidis[0] > targetMidis[1] &&
      targetMidis[1] > targetMidis[2] &&
      targetMidis[2] > targetMidis[3]
    )) {
      throw new Error(`${chord}/${sample}: pitch tiers are not strictly descending`);
    }
    if (rows[2].playback_rate !== 1) {
      throw new Error(`${chord}/${sample}: original tier is not rate 1`);
    }
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
    throw new Error(`Landscape row ${row}: original is not in column 3`);
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
  throw new Error('Portrait original is not in row 3');
}

console.log(`Runtime pitch mapping verified: ${checked} sample/chord/tier cases`);
console.log('Layout verified: landscape column 3 and portrait row 3 are original');
console.log(
  `Worst remeasured transposed error: ` +
  `${report.worst_transposed_target_error_cents.toFixed(3)} cents`,
);
