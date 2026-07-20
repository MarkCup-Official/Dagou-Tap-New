#!/usr/bin/env python3
"""Measure bark-sample pitch and verify Web Audio playbackRate mappings.

Development-only utility. All generated reports and WAV files stay under
tools/tmp so the complete tools directory can be excluded from web packages.

The detector uses a frame-wise YIN estimate and rejects low-energy or
low-confidence frames. Candidate playbackRate values are then applied by
resampling the source samples, after which the rendered result is measured
again instead of relying only on the frequency-ratio formula.
"""

from __future__ import annotations

import argparse
import json
import math
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np


A4_HZ = 440.0
SAMPLE_NAMES = ("da", "gou", "jiao")
CHORDS = (
    ("C", (0, 4, 7)),
    ("G", (7, 11, 2)),
    ("Am", (9, 0, 4)),
    ("F", (5, 9, 0)),
)
TIER_NAMES = ("high_2", "high_1", "original", "low_1")
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


@dataclass
class PitchFrame:
    time_seconds: float
    rms: float
    confidence: float
    frequency_hz: float
    midi: float


@dataclass
class PitchAnalysis:
    anchor_hz: float
    anchor_midi: float
    nearest_note: str
    cents_from_note: float
    voiced_min_hz: float
    voiced_max_hz: float
    voiced_frame_count: int
    total_frame_count: int
    frames: list[PitchFrame]


def midi_from_hz(frequency_hz: float) -> float:
    return 69.0 + 12.0 * math.log2(frequency_hz / A4_HZ)


def hz_from_midi(midi: float) -> float:
    return A4_HZ * (2.0 ** ((midi - 69.0) / 12.0))


def note_label(midi: float) -> tuple[str, float]:
    nearest = int(round(midi))
    name = NOTE_NAMES[nearest % 12]
    octave = nearest // 12 - 1
    cents = (midi - nearest) * 100.0
    return f"{name}{octave}", cents


def weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    order = np.argsort(values)
    sorted_values = values[order]
    cumulative = np.cumsum(weights[order])
    index = int(np.searchsorted(cumulative, cumulative[-1] * 0.5))
    return float(sorted_values[min(index, len(sorted_values) - 1)])


def read_pcm16_wav(path: Path) -> tuple[int, np.ndarray]:
    with wave.open(str(path), "rb") as wav:
        if wav.getsampwidth() != 2:
            raise ValueError(f"{path}: expected 16-bit PCM WAV")
        sample_rate = wav.getframerate()
        channels = wav.getnchannels()
        raw = wav.readframes(wav.getnframes())

    samples = np.frombuffer(raw, dtype="<i2").reshape(-1, channels)
    return sample_rate, samples.astype(np.float64) / 32768.0


def write_pcm16_wav(path: Path, sample_rate: int, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = np.round(pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(pcm.shape[1])
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def yin_track(
    samples: np.ndarray,
    sample_rate: int,
    *,
    frame_size: int = 1536,
    hop_size: int = 160,
    fmin: float = 70.0,
    fmax: float = 1000.0,
    yin_threshold: float = 0.18,
) -> list[PitchFrame]:
    mono = samples.mean(axis=1)
    mono = mono - float(np.mean(mono))
    if len(mono) < frame_size:
        mono = np.pad(mono, (0, frame_size - len(mono)))

    minimum_lag = max(2, int(sample_rate / fmax))
    maximum_lag = min(frame_size - 2, int(sample_rate / fmin))
    frames: list[PitchFrame] = []

    for start in range(0, len(mono) - frame_size + 1, hop_size):
        frame = mono[start : start + frame_size]
        rms = float(np.sqrt(np.mean(frame * frame)))

        difference = np.zeros(maximum_lag + 1, dtype=np.float64)
        for lag in range(1, maximum_lag + 1):
            delta = frame[:-lag] - frame[lag:]
            difference[lag] = float(np.dot(delta, delta))

        cumulative = np.cumsum(difference[1:])
        cmnd = np.ones(maximum_lag + 1, dtype=np.float64)
        lags = np.arange(1, maximum_lag + 1, dtype=np.float64)
        cmnd[1:] = difference[1:] * lags / np.maximum(cumulative, 1e-12)

        middle = cmnd[minimum_lag : maximum_lag - 1]
        local_minimum = (
            (middle < yin_threshold)
            & (middle <= cmnd[minimum_lag - 1 : maximum_lag - 2])
            & (middle < cmnd[minimum_lag + 1 : maximum_lag])
        )
        candidates = np.where(local_minimum)[0] + minimum_lag
        lag_index = int(
            candidates[0]
            if len(candidates)
            else minimum_lag + np.argmin(cmnd[minimum_lag : maximum_lag + 1])
        )
        confidence = float(1.0 - cmnd[lag_index])

        refined_lag = float(lag_index)
        if 1 <= lag_index < maximum_lag:
            left, center, right = cmnd[lag_index - 1 : lag_index + 2]
            denominator = left - 2.0 * center + right
            if abs(denominator) > 1e-12:
                refined_lag += float(0.5 * (left - right) / denominator)

        frequency_hz = sample_rate / refined_lag
        frames.append(
            PitchFrame(
                time_seconds=start / sample_rate,
                rms=rms,
                confidence=confidence,
                frequency_hz=frequency_hz,
                midi=midi_from_hz(frequency_hz),
            )
        )

    return frames


def analyze_pitch(samples: np.ndarray, sample_rate: int) -> PitchAnalysis:
    frames = yin_track(samples, sample_rate)
    if not frames:
        raise ValueError("No analysis frames produced")

    peak_rms = max(frame.rms for frame in frames)
    voiced = [
        frame
        for frame in frames
        if frame.rms >= peak_rms * 0.18 and frame.confidence >= 0.72
    ]
    if not voiced:
        raise ValueError("No sufficiently voiced frames found")

    initial_midis = np.array([frame.midi for frame in voiced], dtype=np.float64)
    initial_weights = np.array(
        [frame.rms * frame.confidence for frame in voiced], dtype=np.float64
    )
    provisional_midi = weighted_median(initial_midis, initial_weights)
    # A short speech frame can occasionally make YIN prefer a strong harmonic.
    # Keep the natural intra-syllable contour while rejecting octave-scale jumps.
    voiced = [frame for frame in voiced if abs(frame.midi - provisional_midi) <= 6.0]

    midi_values = np.array([frame.midi for frame in voiced], dtype=np.float64)
    weights = np.array(
        [frame.rms * frame.confidence for frame in voiced], dtype=np.float64
    )
    anchor_midi = weighted_median(midi_values, weights)
    anchor_hz = hz_from_midi(anchor_midi)
    note, cents = note_label(anchor_midi)
    frequencies = [frame.frequency_hz for frame in voiced]

    return PitchAnalysis(
        anchor_hz=anchor_hz,
        anchor_midi=anchor_midi,
        nearest_note=note,
        cents_from_note=cents,
        voiced_min_hz=min(frequencies),
        voiced_max_hz=max(frequencies),
        voiced_frame_count=len(voiced),
        total_frame_count=len(frames),
        frames=voiced,
    )


def playback_rate_resample(samples: np.ndarray, rate: float) -> np.ndarray:
    """Approximate AudioBufferSourceNode playbackRate with sample resampling."""
    output_length = max(1, int(math.ceil(len(samples) / rate)))
    source_positions = np.arange(output_length, dtype=np.float64) * rate
    source_positions = np.minimum(source_positions, len(samples) - 1)
    source_indices = np.arange(len(samples), dtype=np.float64)
    output = np.empty((output_length, samples.shape[1]), dtype=np.float64)
    for channel in range(samples.shape[1]):
        output[:, channel] = np.interp(
            source_positions, source_indices, samples[:, channel]
        )
    return output


def chord_tones_around(anchor_midi: float, pitch_classes: tuple[int, ...]) -> list[int]:
    return [
        midi
        for midi in range(24, 109)
        if midi % 12 in pitch_classes and abs(midi - anchor_midi) > 1e-7
    ]


def targets_for_anchor(
    anchor_midi: float, pitch_classes: tuple[int, ...]
) -> tuple[int, int, None, int]:
    tones = chord_tones_around(anchor_midi, pitch_classes)
    above = [midi for midi in tones if midi > anchor_midi]
    below = [midi for midi in tones if midi < anchor_midi]
    if len(above) < 2 or not below:
        raise ValueError(f"Not enough chord tones around MIDI {anchor_midi:.3f}")
    return above[1], above[0], None, below[-1]


def serialise_analysis(analysis: PitchAnalysis) -> dict:
    data = asdict(analysis)
    data["frames"] = [asdict(frame) for frame in analysis.frames]
    return data


def safe_file_part(value: str) -> str:
    return value.replace("#", "sharp").replace("/", "-")


def run(args: argparse.Namespace) -> int:
    audio_dir = args.audio_dir.resolve()
    output_path = args.output.resolve()
    temp_dir = args.temp_dir.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir.mkdir(parents=True, exist_ok=True)

    sources: dict[str, tuple[int, np.ndarray, PitchAnalysis]] = {}
    for sample_name in SAMPLE_NAMES:
        path = audio_dir / f"{sample_name}.wav"
        sample_rate, samples = read_pcm16_wav(path)
        sources[sample_name] = (
            sample_rate,
            samples,
            analyze_pitch(samples, sample_rate),
        )

    mappings = []
    worst_error_cents = 0.0
    for chord_index, (chord_name, pitch_classes) in enumerate(CHORDS):
        for sample_name in SAMPLE_NAMES:
            sample_rate, samples, source_analysis = sources[sample_name]
            targets = targets_for_anchor(source_analysis.anchor_midi, pitch_classes)

            for tier_index, tier_name in enumerate(TIER_NAMES):
                target_midi = targets[tier_index]
                if target_midi is None:
                    rate = 1.0
                    rendered = samples
                else:
                    rate = 2.0 ** (
                        (target_midi - source_analysis.anchor_midi) / 12.0
                    )
                    rendered = playback_rate_resample(samples, rate)

                rendered_analysis = analyze_pitch(rendered, sample_rate)
                target_note = None
                target_hz = None
                error_cents = None
                if target_midi is not None:
                    target_note = note_label(float(target_midi))[0]
                    target_hz = hz_from_midi(float(target_midi))
                    error_cents = (
                        rendered_analysis.anchor_midi - float(target_midi)
                    ) * 100.0
                    worst_error_cents = max(worst_error_cents, abs(error_cents))

                if args.write_wavs:
                    target_part = target_note or "raw"
                    filename = (
                        f"{chord_index + 1}-{safe_file_part(chord_name)}_"
                        f"{sample_name}_{tier_index + 1}-{tier_name}_"
                        f"{safe_file_part(target_part)}_rate-{rate:.8f}.wav"
                    )
                    write_pcm16_wav(temp_dir / filename, sample_rate, rendered)

                mappings.append(
                    {
                        "chord_index": chord_index,
                        "chord": chord_name,
                        "sample": sample_name,
                        "tier_index": tier_index,
                        "tier": tier_name,
                        "source_anchor_hz": source_analysis.anchor_hz,
                        "source_anchor_midi": source_analysis.anchor_midi,
                        "target_note": target_note,
                        "target_hz": target_hz,
                        "target_midi": target_midi,
                        "playback_rate": rate,
                        "remeasured_hz": rendered_analysis.anchor_hz,
                        "remeasured_midi": rendered_analysis.anchor_midi,
                        "target_error_cents": error_cents,
                        "remeasured_voiced_min_hz": rendered_analysis.voiced_min_hz,
                        "remeasured_voiced_max_hz": rendered_analysis.voiced_max_hz,
                    }
                )

    report = {
        "method": {
            "detector": "frame-wise YIN",
            "anchor": "RMS × confidence weighted median of voiced-frame MIDI",
            "a4_hz": A4_HZ,
            "tier_rule": (
                "second chord tone above, nearest chord tone above, "
                "unshifted original, nearest chord tone below"
            ),
        },
        "sources": {
            name: serialise_analysis(values[2]) for name, values in sources.items()
        },
        "mappings": mappings,
        "worst_transposed_target_error_cents": worst_error_cents,
    }
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("Source pitch anchors")
    for sample_name, (_, _, analysis) in sources.items():
        print(
            f"  {sample_name:4s} {analysis.anchor_hz:8.3f} Hz  "
            f"MIDI {analysis.anchor_midi:8.4f}  "
            f"{analysis.nearest_note} {analysis.cents_from_note:+6.2f} cents  "
            f"voiced {analysis.voiced_min_hz:.2f}..{analysis.voiced_max_hz:.2f} Hz"
        )
    print(f"Verified mappings: {len(mappings)}")
    print(f"Worst transposed target error: {worst_error_cents:.3f} cents")
    print(f"Report: {output_path}")
    if args.write_wavs:
        print(f"Rendered verification WAVs: {temp_dir}")

    return 1 if worst_error_cents > args.strict_cents else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-dir", type=Path, default=Path("audio"))
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("tools/tmp/pitch-analysis-report.json"),
    )
    parser.add_argument(
        "--temp-dir",
        type=Path,
        default=Path("tools/tmp/rendered"),
    )
    parser.add_argument("--write-wavs", action="store_true")
    parser.add_argument(
        "--strict-cents",
        type=float,
        default=25.0,
        help="Exit nonzero if a remeasured transposed anchor misses by more.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
