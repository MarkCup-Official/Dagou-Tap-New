#!/usr/bin/env node

// Executes the actual interaction helpers extracted from main.js. This keeps
// geometry, queue timing, and jiao sustain-retuning checks outside production.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(toolsDir);
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');

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

assert.equal(
  mainSource.includes('lastGlobalHit'),
  false,
  'the former same-beat drop gate must not remain',
);
assert.match(
  extractFunction('scheduler'),
  /scheduleQueuedInputs\(ctx\.currentTime \+ INPUT_QUEUE_LOOKAHEAD\)/,
  'the audio lookahead scheduler must drain the input queue',
);
assert.match(
  extractFunction('tryActivate'),
  /zonesAlongSegment\(/,
  'pointer movement must traverse every crossed zone',
);
assert.doesNotMatch(
  extractFunction('retuneSustainVoice'),
  /createBufferSource|\.start\(/,
  'jiao sustain retuning must not create or restart an onset source',
);
assert.match(
  extractFunction('retuneHeldJiao'),
  /enqueueSustainRetune\(/,
  'crossed jiao sustain pitches must join the rhythmic input queue',
);
assert.match(
  extractFunction('playQueuedInput'),
  /entry\.kind === 'sustain-retune'[\s\S]*retuneSustainVoice\(/,
  'a queued sustain event must retune the existing voice',
);
assert.match(
  extractFunction('commitUnsnappedInput'),
  /entry\.when = ctx\.currentTime[\s\S]*playQueuedInput\(entry\)/,
  'free rhythm must commit each input immediately at the actual press time',
);
for (const name of ['enqueueActivation', 'enqueueSustainRetune']) {
  assert.match(
    extractFunction(name),
    /removeQueuedSample\(z\.sample\)/,
    `${name} must replace an older queued item of the same sample`,
  );
  assert.match(
    extractFunction(name),
    /reflowQueuedInputTimes\(\)/,
    `${name} must compact the remaining queue after replacement`,
  );
}

const sandbox = {};
vm.runInNewContext(
  `
  let cols = 4;
  let rows = 3;
  let stageMetrics = { width: 400, height: 300, left: 0, top: 0 };
  function getStageMetrics() { return stageMetrics; }
  const pointers = new Map();
  ${extractFunction('zoneIndex')}
  ${extractFunction('zonesAlongSegment')}
  let enqueuedZones = [];
  let swipeEntrySerial = 0;
  function retuneHeldJiao() { return false; }
  function releaseVoice() {}
  function commitUnsnappedInput() {}
  function enqueueActivation(zi) {
    enqueuedZones.push(zi);
    return { id: ++swipeEntrySerial };
  }
  ${extractFunction('enterZone')}
  ${extractFunction('tryActivate')}

  const S8 = 0.25;
  const inputQueue = [];
  const performanceSettings = { rhythmSnap: true };
  let lastCommittedInputTime = -Infinity;
  let quantizedTime = 1;
  function quantize() { return quantizedTime; }
  ${extractFunction('reflowQueuedInputTimes')}

  const RELEASE_SCHEDULE_LEAD = 0.006;
  let ctx = { currentTime: 2 };
  ${extractFunction('texturePositionAt')}
  ${extractFunction('textureRateAt')}
  ${extractFunction('isRetunableSustainVoice')}
  ${extractFunction('retuneSustainVoice')}
  ${extractFunction('nextTextureRelease')}

  globalThis.interactionApi = {
    setGrid(nextCols, nextRows, width, height) {
      cols = nextCols;
      rows = nextRows;
      stageMetrics = { width, height, left: 0, top: 0 };
    },
    segment: zonesAlongSegment,
    runSwipe(x0, y0, x1, y1) {
      enqueuedZones = [];
      let state = tryActivate(7, x0, y0, null);
      state = tryActivate(7, x1, y1, state);
      return { zones: [...enqueuedZones], state };
    },
    reflowQueue(length, nextBeat, committed = -Infinity) {
      inputQueue.length = 0;
      for (let i = 0; i < length; i++) inputQueue.push({ when: 0 });
      quantizedTime = nextBeat;
      lastCommittedInputTime = committed;
      reflowQueuedInputTimes();
      return inputQueue.map(entry => entry.when);
    },
    setNow(now) { ctx.currentTime = now; },
    texturePositionAt,
    textureRateAt,
    retuneSustainVoice,
    nextTextureRelease,
  };
  `,
  sandbox,
);

const api = sandbox.interactionApi;
const plain = value => Array.from(value);

const sustainQueueSandbox = {};
vm.runInNewContext(
  `
  const S8 = 0.25;
  let lastCommittedInputTime = -Infinity;
  let inputSerial = 0;
  const inputQueue = [];
  const performanceSettings = { rhythmSnap: true };
  const pointers = new Map();
  const zones = [
    { sample: 'da', pitchTier: 0 },
    { sample: 'gou', pitchTier: 0 },
    { sample: 'jiao', pitchTier: 0 },
    { sample: 'jiao', pitchTier: 1 },
    { sample: 'da', pitchTier: 1 },
  ];
  function quantize() { return 1; }
  function hideControlsUntilIdle() {}
  function flashZone() {}
  function commitUnsnappedInput() {}
  function resolveSfxSample(sample) {
    return ({ da: 'ha', gou: 'ji', jiao: 'mi' })[sample] ?? sample;
  }
  ${extractFunction('reflowQueuedInputTimes')}
  ${extractFunction('removeQueuedSample')}
  ${extractFunction('enqueueActivation')}
  ${extractFunction('enqueueSustainRetune')}
  ${extractFunction('isRetunableSustainVoice')}
  ${extractFunction('retuneHeldJiao')}

  enqueueActivation(0, 7);
  enqueueActivation(1, 7);
  enqueueActivation(4, 7);
  const pressEntries = inputQueue.map(entry => ({
    id: entry.id,
    sample: entry.sample,
    audioSample: entry.audioSample,
    pitchTier: entry.pitchTier,
    when: entry.when,
  }));

  inputQueue.length = 0;
  inputSerial = 0;
  lastCommittedInputTime = -Infinity;
  const voice = {
    name: 'dingdongji_ji',
    mode: 'sustain',
    held: true,
    released: false,
    stopped: false,
    cleaned: false,
    rate: 1,
  };
  const state = { zone: 2, voice, pendingEntryId: null };
  const acceptedFirst = retuneHeldJiao(7, state, 3);
  const acceptedSecond = retuneHeldJiao(7, state, 2);
  globalThis.sustainQueueResult = {
    pressEntries,
    acceptedFirst,
    acceptedSecond,
    zone: state.zone,
    voiceRate: voice.rate,
    queueLength: inputQueue.length,
    entry: { ...inputQueue[0], voice: inputQueue[0].voice === voice },
  };
  `,
  sustainQueueSandbox,
);

const freeRhythmSandbox = {};
vm.runInNewContext(
  `
  const performanceSettings = { rhythmSnap: false };
  const inputQueue = [];
  let lastCommittedInputTime = -Infinity;
  const ctx = { currentTime: 4.2 };
  const played = [];
  function playQueuedInput(entry) { played.push({ ...entry }); }
  ${extractFunction('removeQueuedSample')}
  ${extractFunction('commitUnsnappedInput')}

  const first = { id: 1, sample: 'da', when: 0 };
  const second = { id: 2, sample: 'da', when: 0 };
  inputQueue.push(first, second);
  removeQueuedSample('da');
  commitUnsnappedInput(first);
  commitUnsnappedInput(second);
  globalThis.freeRhythmResult = {
    queueLength: inputQueue.length,
    played,
    committedAt: lastCommittedInputTime,
  };
  `,
  freeRhythmSandbox,
);

assert.deepEqual(
  JSON.parse(JSON.stringify(freeRhythmSandbox.freeRhythmResult)),
  {
    queueLength: 0,
    played: [
      { id: 1, sample: 'da', when: 4.2 },
      { id: 2, sample: 'da', when: 4.2 },
    ],
    committedAt: 4.2,
  },
  'free rhythm must keep repeated samples and play every input immediately',
);

assert.deepEqual(
  JSON.parse(JSON.stringify(sustainQueueSandbox.sustainQueueResult)),
  {
    pressEntries: [
      { id: 2, sample: 'gou', audioSample: 'ji', pitchTier: 0, when: 1 },
      { id: 3, sample: 'da', audioSample: 'ha', pitchTier: 1, when: 1.25 },
    ],
    acceptedFirst: true,
    acceptedSecond: true,
    zone: 2,
    voiceRate: 1,
    queueLength: 1,
    entry: {
      id: 2,
      kind: 'sustain-retune',
      pointerId: 7,
      zone: 2,
      sample: 'jiao',
      audioSample: 'dingdongji_ji',
      pitchTier: 0,
      voice: true,
      when: 1,
    },
  },
  'each sample must keep only its newest queued press or sustain retune',
);

api.setGrid(4, 3, 400, 300);
assert.deepEqual(
  plain(api.runSwipe(10, 50, 390, 50).zones),
  [0, 1, 2, 3],
  'the pointer state machine must enqueue every crossed zone in order',
);
assert.deepEqual(
  plain(api.segment(10, 50, 390, 50)),
  [0, 1, 2, 3],
  'fast horizontal movement must include both middle zones',
);
assert.deepEqual(
  plain(api.segment(390, 50, 10, 50)),
  [3, 2, 1, 0],
  'reverse movement must preserve reverse entry order',
);
assert.deepEqual(
  plain(api.segment(50, 10, 50, 290)),
  [0, 4, 8],
  'fast vertical movement must include the middle row',
);

api.setGrid(3, 4, 300, 400);
assert.deepEqual(
  plain(api.segment(250, 10, 250, 390)),
  [2, 5, 8, 11],
  'portrait movement must include every crossed pitch row',
);

assert.deepEqual(
  plain(api.reflowQueue(3, 1)),
  [1, 1.25, 1.5],
  'queued hits must occupy consecutive eighth-note slots',
);
assert.deepEqual(
  plain(api.reflowQueue(2, 2, 2.25)),
  [2.5, 2.75],
  'queued hits must start after the most recently committed slot',
);

const rateEvents = [];
const voice = {
  name: 'jiao',
  mode: 'sustain',
  held: true,
  released: false,
  stopped: false,
  cleaned: false,
  handoffAt: 1,
  sustain: {
    attackOffset: 0.25,
    buffer: { duration: 10 },
    releasePoints: [{ textureOffset: 3, sourceOffset: 0.4 }],
  },
  rateTimeline: [{ time: 1, rate: 2 }],
  rate: 2,
  loopSource: {
    playbackRate: {
      cancelScheduledValues: time => rateEvents.push(['cancel', time]),
      setValueAtTime: (rate, time) => rateEvents.push(['set', rate, time]),
    },
  },
};

api.setNow(2);
assert.equal(api.retuneSustainVoice(voice, 0.75), true);
assert.equal(voice.rate, 0.75);
assert.deepEqual(rateEvents, [['cancel', 2], ['set', 0.75, 2]]);
assert.equal(api.texturePositionAt(voice, 2), 2.25);
assert.equal(api.textureRateAt(voice, 2), 0.75);

assert.deepEqual(
  { ...api.nextTextureRelease(voice, 2) },
  { boundary: 3, sourceOffset: 0.4 },
  'release scheduling must continue from the retuned texture position',
);

voice.rateTimeline = [{ time: 1, rate: 2 }];
voice.rate = 2;
api.setNow(0.95);
assert.equal(api.retuneSustainVoice(voice, 0.5), true);
assert.equal(
  api.texturePositionAt(voice, 0.95),
  0.25,
  'an early sustain claim must not advance texture before handoff',
);

voice.rateTimeline = [{ time: 1, rate: 2 }];
voice.rate = 2;
rateEvents.length = 0;
api.setNow(2);
assert.equal(api.retuneSustainVoice(voice, 0.5, 2.1), true);
assert.deepEqual(rateEvents, [['cancel', 2.1], ['set', 0.5, 2.1]]);
assert.equal(
  api.textureRateAt(voice, 2.05),
  2,
  'lookahead scheduling must not change a sustain pitch before its queue slot',
);
assert.equal(api.textureRateAt(voice, 2.1), 0.5);

console.log('Interaction queue verification passed:');
console.log('- landscape and portrait fast swipes include every crossed zone');
console.log('- queued hits occupy consecutive eighth-note slots');
console.log('- da, gou, and jiao each keep only their newest queued item');
console.log('- held third-syllable voices retune in place and keep release-frame tracking');
console.log('- free rhythm bypasses quantization and same-sample queue replacement');
