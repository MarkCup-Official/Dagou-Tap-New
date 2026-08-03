import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [html, main] = await Promise.all([
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('main.js', root), 'utf8'),
]);

assert.doesNotMatch(html, /id="midi-record-button"/, 'old panel recorder must be removed');
assert.match(html, /id="voice-loop-button"[^>]+role="switch"[^>]+aria-checked="false"/);
assert.match(html, /id="voice-loop-status"[^>]+role="status" aria-live="polite"/);
assert.match(html, /id="midi-stop-btn"[^>]+aria-label="重置录音或导入内容"/);
assert.match(main, /navigator\.mediaDevices\?\.getUserMedia/);
assert.match(main, /new MediaRecorder/);
assert.match(main, /addEventListener\('dataavailable'/);
assert.match(main, /addEventListener\('stop'/);
assert.match(main, /VOICE_LOOP_SILENCE_MS = 1200/);
assert.match(main, /VOICE_LOOP_MAX_UTTERANCE_MS = 20000/);
assert.match(main, /getFloatTimeDomainData/);
assert.match(main, /singVoiceLoopUtterance/);
assert.match(main, /await configureAudioFile\(file, await blob\.arrayBuffer\(\)\)/);
assert.match(main, /midiSchedulePlayback\(\)/);
assert.match(main, /muteMusicForVoiceLoop/);
assert.match(main, /restoreVoiceLoopMusic/);
assert.doesNotMatch(main, /URL\.createObjectURL\(blob\)/, 'must sing instead of replaying raw audio');
assert.match(main, /function resetSingingInput/);
assert.match(main, /midiStopBtn\.addEventListener\('click', \(\) => resetSingingInput\(\)\)/);

console.log('Automatic voice-loop flow checks passed.');
