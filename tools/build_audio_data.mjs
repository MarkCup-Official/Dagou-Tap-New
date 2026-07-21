#!/usr/bin/env node

// Rebuild the production base64 bundle from the explicitly supported samples.
// Keeping the list explicit prevents unrelated work-in-progress audio files from
// silently increasing the published payload.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(toolsDir);
const audioDir = path.join(rootDir, 'audio');
const outputPath = path.join(rootDir, 'audio-data.js');
const sampleFiles = Object.freeze({
  da: 'da.wav',
  gou: 'gou.wav',
  jiao: 'jiao.wav',
  // Keep the runtime keys stable while embedding the user's denoised revisions.
  ha: 'ha_new.wav',
  ji: 'ji_new.wav',
  mi: 'mi_new.wav',
  dingdongji_ding: 'dingdongji_ding.wav',
  dingdongji_dong: 'dingdongji_dong.wav',
  dingdongji_ji: 'dingdongji_ji.wav',
});

const entries = Object.entries(sampleFiles).map(([sampleName, relativePath]) => {
  const audioPath = path.join(audioDir, ...relativePath.split('/'));
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Missing runtime sample: ${audioPath}`);
  }
  return `  ${sampleName}: '${fs.readFileSync(audioPath).toString('base64')}',`;
});

const source = [
  '/* 自动生成的音频数据（base64），来源：audio 文件夹中的运行时 WAV */',
  'const AUDIO_B64 = {',
  ...entries,
  '};',
  '',
].join('\n');

fs.writeFileSync(outputPath, source, 'utf8');
console.log(`Embedded ${Object.keys(sampleFiles).length} samples in ${outputPath}`);
