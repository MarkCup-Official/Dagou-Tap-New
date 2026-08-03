'use strict';

(function initAudioMelody(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AudioMelody = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAudioMelody() {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function frequencyToMidi(frequency) {
    return 69 + 12 * Math.log2(frequency / 440);
  }

  function prepareSamples(channels, inputRate, options = {}) {
    if (!Array.isArray(channels) || !channels.length || !channels[0]?.length) {
      throw new Error('音频没有可分析的声道');
    }
    const targetRate = options.targetRate || 12000;
    const maxSeconds = options.maxSeconds || 600;
    const sourceLength = Math.min(
      channels[0].length,
      Math.floor(inputRate * maxSeconds)
    );
    const outputLength = Math.max(
      1,
      Math.floor(sourceLength * targetRate / inputRate)
    );
    const output = new Float32Array(outputLength);
    let peak = 0;
    let previousInput = 0;
    let previousOutput = 0;

    for (let i = 0; i < outputLength; i++) {
      const sourcePosition = i * inputRate / targetRate;
      const base = Math.floor(sourcePosition);
      const fraction = sourcePosition - base;
      let mono = 0;
      for (const channel of channels) {
        const a = channel[Math.min(base, sourceLength - 1)] || 0;
        const b = channel[Math.min(base + 1, sourceLength - 1)] || a;
        mono += a + (b - a) * fraction;
      }
      mono /= channels.length;
      // 约 20Hz 的一阶高通，去除直流和极低频漂移。
      const filtered = mono - previousInput + 0.9895 * previousOutput;
      previousInput = mono;
      previousOutput = filtered;
      output[i] = filtered;
      peak = Math.max(peak, Math.abs(filtered));
    }
    if (peak > 0.0001 && peak < 0.65) {
      const gain = Math.min(8, 0.65 / peak);
      for (let i = 0; i < output.length; i++) output[i] *= gain;
    }
    return { samples: output, sampleRate: targetRate };
  }

  function yinFrame(samples, offset, sampleRate, options = {}) {
    const frameSize = options.frameSize || 512;
    const minFrequency = options.minFrequency || 110;
    const maxFrequency = options.maxFrequency || 1000;
    const threshold = options.yinThreshold || 0.16;
    if (offset + frameSize >= samples.length) return null;
    const minTau = Math.max(2, Math.floor(sampleRate / maxFrequency));
    const maxTau = Math.min(
      Math.floor(sampleRate / minFrequency),
      Math.floor(frameSize / 2)
    );
    const difference = new Float32Array(maxTau + 1);
    let rmsSum = 0;
    for (let i = 0; i < frameSize; i++) {
      const value = samples[offset + i];
      rmsSum += value * value;
    }
    const rms = Math.sqrt(rmsSum / frameSize);

    const compareLength = frameSize - maxTau;
    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < compareLength; i++) {
        const delta = samples[offset + i] - samples[offset + i + tau];
        sum += delta * delta;
      }
      difference[tau] = sum;
    }
    let runningSum = 0;
    difference[0] = 1;
    for (let tau = 1; tau <= maxTau; tau++) {
      runningSum += difference[tau];
      difference[tau] = runningSum > 0
        ? difference[tau] * tau / runningSum
        : 1;
    }

    let tau = -1;
    for (let candidate = minTau; candidate <= maxTau; candidate++) {
      if (difference[candidate] < threshold) {
        while (
          candidate + 1 <= maxTau &&
          difference[candidate + 1] < difference[candidate]
        ) {
          candidate++;
        }
        tau = candidate;
        break;
      }
    }
    if (tau < 0) {
      let best = minTau;
      for (let candidate = minTau + 1; candidate <= maxTau; candidate++) {
        if (difference[candidate] < difference[best]) best = candidate;
      }
      if (difference[best] > 0.28) return { rms, frequency: 0, confidence: 0 };
      tau = best;
    }

    const left = difference[Math.max(minTau, tau - 1)];
    const center = difference[tau];
    const right = difference[Math.min(maxTau, tau + 1)];
    const denominator = left - 2 * center + right;
    const correction = Math.abs(denominator) > 1e-9
      ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5)
      : 0;
    const refinedTau = tau + correction;
    return {
      rms,
      frequency: sampleRate / refinedTau,
      confidence: clamp(1 - center, 0, 1),
    };
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function fftPowerSpectrum(samples, offset, size) {
    const real = new Float64Array(size);
    const imaginary = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
      real[i] = (samples[offset + i] || 0) * window;
    }
    for (let i = 1, j = 0; i < size; i++) {
      let bit = size >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
      }
    }
    for (let length = 2; length <= size; length <<= 1) {
      const angle = -2 * Math.PI / length;
      const wLengthReal = Math.cos(angle);
      const wLengthImaginary = Math.sin(angle);
      for (let start = 0; start < size; start += length) {
        let wReal = 1;
        let wImaginary = 0;
        for (let i = 0; i < length / 2; i++) {
          const even = start + i;
          const odd = even + length / 2;
          const oddReal =
            real[odd] * wReal - imaginary[odd] * wImaginary;
          const oddImaginary =
            real[odd] * wImaginary + imaginary[odd] * wReal;
          real[odd] = real[even] - oddReal;
          imaginary[odd] = imaginary[even] - oddImaginary;
          real[even] += oddReal;
          imaginary[even] += oddImaginary;
          const nextReal =
            wReal * wLengthReal - wImaginary * wLengthImaginary;
          wImaginary =
            wReal * wLengthImaginary + wImaginary * wLengthReal;
          wReal = nextReal;
        }
      }
    }
    const power = new Float64Array(size / 2);
    for (let i = 0; i < power.length; i++) {
      power[i] = real[i] * real[i] + imaginary[i] * imaginary[i];
    }
    return power;
  }

  function spectralPowerAt(power, frequency, sampleRate, fftSize) {
    const position = frequency * fftSize / sampleRate;
    const base = Math.floor(position);
    if (base < 1 || base + 1 >= power.length) return 0;
    const fraction = position - base;
    return power[base] * (1 - fraction) + power[base + 1] * fraction;
  }

  async function trackSpectralMelody(samples, sampleRate, options = {}) {
    const fftSize = options.spectralFftSize || 2048;
    const hopSize = options.hopSize || Math.round(sampleRate * 0.04);
    const minMidi = options.spectralMinMidi || 52;
    const maxMidi = options.spectralMaxMidi || 84;
    const frameCount = Math.max(0, Math.floor((samples.length - fftSize) / hopSize));
    let globalSum = 0;
    for (const value of samples) globalSum += value * value;
    const globalRms = Math.sqrt(globalSum / Math.max(1, samples.length));
    const rmsFloor = Math.max(0.005, globalRms * 0.11);
    const frames = [];
    let previousMidi = null;
    let silentFrames = 0;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const offset = frameIndex * hopSize;
      let rmsSum = 0;
      for (let i = 0; i < fftSize; i++) {
        const value = samples[offset + i] || 0;
        rmsSum += value * value;
      }
      const rms = Math.sqrt(rmsSum / fftSize);
      if (rms < rmsFloor) {
        frames.push(null);
        previousMidi = null;
        silentFrames++;
        continue;
      }
      const power = fftPowerSpectrum(samples, offset, fftSize);
      const candidates = [];
      for (let midi = minMidi; midi <= maxMidi; midi++) {
        const frequency = 440 * Math.pow(2, (midi - 69) / 12);
        const fundamental = spectralPowerAt(power, frequency, sampleRate, fftSize);
        const harmonic2 = spectralPowerAt(power, frequency * 2, sampleRate, fftSize);
        const harmonic3 = spectralPowerAt(power, frequency * 3, sampleRate, fftSize);
        const harmonic4 = spectralPowerAt(power, frequency * 4, sampleRate, fftSize);
        const subharmonic = spectralPowerAt(power, frequency / 2, sampleRate, fftSize);
        const salience =
          Math.log1p(fundamental * 1e3) +
          0.62 * Math.log1p(harmonic2 * 1e3) +
          0.38 * Math.log1p(harmonic3 * 1e3) +
          0.22 * Math.log1p(harmonic4 * 1e3) -
          0.24 * Math.log1p(subharmonic * 1e3);
        candidates.push({ midi, salience });
      }
      candidates.sort((a, b) => b.salience - a.salience);
      const strongest = Math.max(1e-9, candidates[0].salience);
      const shortlist = candidates.slice(0, 6);
      let selected = shortlist[0];
      let bestScore = -Infinity;
      for (const candidate of shortlist) {
        const distance = previousMidi == null
          ? 0
          : Math.abs(candidate.midi - previousMidi);
        const transitionPenalty =
          distance * 0.055 + Math.max(0, distance - 7) * 0.18;
        const score = candidate.salience / strongest - transitionPenalty;
        if (score > bestScore) {
          bestScore = score;
          selected = candidate;
        }
      }
      const margin = Math.max(
        0,
        (selected.salience - (candidates[1]?.salience || 0)) / strongest
      );
      frames.push({
        rms,
        frequency: 440 * Math.pow(2, (selected.midi - 69) / 12),
        confidence: clamp(0.7 + margin * 0.28, 0.7, 0.98),
        spectral: true,
      });
      previousMidi = selected.midi;
      if (frameIndex % 20 === 0) {
        options.onProgress?.(0.55 + frameIndex / Math.max(1, frameCount) * 0.45);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    return { frames, silentFrames };
  }

  function framesToNotes(frames, hopSeconds, options = {}) {
    const minConfidence = options.minConfidence || 0.68;
    const minNoteDuration = options.minNoteDuration || 0.12;
    const voiced = frames.map((frame, index) => {
      if (!frame || frame.confidence < minConfidence || frame.frequency <= 0) {
        return null;
      }
      const neighbors = [];
      for (let j = Math.max(0, index - 2); j <= Math.min(frames.length - 1, index + 2); j++) {
        const item = frames[j];
        if (item?.confidence >= minConfidence && item.frequency > 0) {
          neighbors.push(frequencyToMidi(item.frequency));
        }
      }
      const smoothed = median(neighbors);
      return smoothed == null ? null : Math.round(smoothed);
    });

    // 一帧的尖峰通常是伴奏瞬态；用两侧一致音高替换。
    for (let i = 1; i < voiced.length - 1; i++) {
      if (
        voiced[i - 1] != null &&
        voiced[i + 1] != null &&
        Math.abs(voiced[i - 1] - voiced[i + 1]) <= 1 &&
        (voiced[i] == null || Math.abs(voiced[i] - voiced[i - 1]) >= 3)
      ) {
        voiced[i] = Math.round((voiced[i - 1] + voiced[i + 1]) / 2);
      }
    }

    const notes = [];
    let start = 0;
    while (start < voiced.length) {
      if (voiced[start] == null) {
        start++;
        continue;
      }
      const pitches = [voiced[start]];
      let end = start + 1;
      while (
        end < voiced.length &&
        voiced[end] != null &&
        Math.abs(voiced[end] - median(pitches)) <= 1
      ) {
        pitches.push(voiced[end]);
        end++;
      }
      const duration = (end - start) * hopSeconds;
      if (duration >= minNoteDuration) {
        const midiNote = Math.round(median(pitches));
        const confidence = median(
          frames.slice(start, end).map(frame => frame?.confidence || 0)
        ) || 0;
        notes.push({
          midiNote,
          startTime: start * hopSeconds,
          duration,
          velocity: Math.round(72 + confidence * 48),
          ch: '0',
        });
      }
      start = end;
    }

    const merged = [];
    for (const note of notes) {
      const previous = merged[merged.length - 1];
      const gap = previous
        ? note.startTime - (previous.startTime + previous.duration)
        : Infinity;
      if (previous && previous.midiNote === note.midiNote && gap <= 0.09) {
        previous.duration = note.startTime + note.duration - previous.startTime;
        previous.velocity = Math.round((previous.velocity + note.velocity) / 2);
      } else {
        merged.push({ ...note });
      }
    }
    return merged;
  }

  async function analyzeSamples(samples, sampleRate, options = {}) {
    const frameSize = options.frameSize || 512;
    const hopSize = options.hopSize || Math.round(sampleRate * 0.04);
    const globalRms = Math.sqrt(
      samples.reduce((sum, value) => sum + value * value, 0) /
      Math.max(1, samples.length)
    );
    const rmsFloor = Math.max(0.006, globalRms * 0.16);
    const frames = [];
    const frameCount = Math.max(0, Math.floor((samples.length - frameSize) / hopSize));
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const result = yinFrame(
        samples,
        frameIndex * hopSize,
        sampleRate,
        options
      );
      frames.push(result && result.rms >= rmsFloor ? result : null);
      if (frameIndex % 40 === 0) {
        options.onProgress?.(frameIndex / Math.max(1, frameCount) * 0.55);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    let method = 'yin';
    let notes = framesToNotes(frames, hopSize / sampleRate, options);
    const voicedDuration = notes.reduce((sum, note) => sum + note.duration, 0);
    const duration = samples.length / sampleRate;
    if (
      duration >= 2 &&
      voicedDuration / Math.max(0.001, duration) <
        (options.spectralFallbackCoverage || 0.08)
    ) {
      const spectral = await trackSpectralMelody(samples, sampleRate, {
        ...options,
        hopSize,
      });
      const spectralNotes = framesToNotes(
        spectral.frames,
        hopSize / sampleRate,
        {
          ...options,
          minConfidence: 0.68,
          minNoteDuration: options.minNoteDuration || 0.12,
        }
      );
      if (spectralNotes.length > notes.length) {
        frames.length = 0;
        frames.push(...spectral.frames);
        notes = spectralNotes;
        method = 'spectral';
      }
    }
    options.onProgress?.(1);
    return {
      notes,
      frames,
      duration,
      sampleRate,
      method,
    };
  }

  return Object.freeze({
    frequencyToMidi,
    prepareSamples,
    yinFrame,
    framesToNotes,
    trackSpectralMelody,
    analyzeSamples,
  });
});
