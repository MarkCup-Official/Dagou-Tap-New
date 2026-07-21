#!/usr/bin/env python3
"""Measure SFX pitch/loudness and verify Web Audio playback mappings.

Development-only utility. All generated reports and WAV files stay under
tools/tmp so the complete tools directory can be excluded from web packages.

The detector uses a frame-wise YIN estimate and rejects low-energy or
low-confidence frames. Normal screen keys use fixed A-minor-pentatonic targets;
piano mode uses the C4-C5 white-key octave. Candidate playbackRate values are
then applied by resampling the source samples, after which the rendered result
is measured again instead of relying only on the frequency-ratio formula.

Loudness is calibrated from gated 20 ms RMS frames. Every sample receives a
fixed gain that matches the active RMS of da.wav; the same gain is rechecked on
all normal and piano-mode transpositions.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np


A4_HZ = 440.0
SFX_SAMPLE_SETS = {
    "dagou": ("da", "gou", "jiao"),
    "hajimi": ("ha", "ji", "mi"),
    "dingdong": ("dingdongji_ding", "dingdongji_dong", "dingdongji_ji"),
}
SAMPLE_NAMES = tuple(
    sample_name
    for sample_names in SFX_SAMPLE_SETS.values()
    for sample_name in sample_names
)
SAMPLE_TO_SFX = {
    sample_name: sfx_id
    for sfx_id, sample_names in SFX_SAMPLE_SETS.items()
    for sample_name in sample_names
}
SAMPLE_SOURCE_FILES = {
    "ha": Path("ha_new.wav"),
    "ji": Path("ji_new.wav"),
    "mi": Path("mi_new.wav"),
}
MINOR_PENTATONIC_PITCH_CLASSES = (9, 0, 2, 4, 7)  # A, C, D, E, G
FIXED_TARGET_MIDI = {
    "da": (79, 76, 72, 69),    # G5, E5, C5, A4
    "gou": (72, 69, 67, 64),   # C5, A4, G4, E4
    "jiao": (79, 76, 72, 69),  # G5, E5, C5, A4
    "ha": (79, 76, 72, 69),    # G5, E5, C5, A4
    "ji": (72, 69, 67, 64),    # C5, A4, G4, E4
    "mi": (69, 67, 64, 62),    # A4, G4, E4, D4
    "dingdongji_ding": (74, 72, 69, 67),  # D5, C5, A4, G4
    "dingdongji_dong": (74, 72, 69, 67),  # D5, C5, A4, G4
    "dingdongji_ji": (74, 72, 69, 67),    # D5, C5, A4, G4
}
PIANO_TARGET_MIDI = (60, 62, 64, 65, 67, 69, 71, 72)
TIER_NAMES = ("pitch_1", "pitch_2", "nearest_minor", "pitch_4")
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
LOUDNESS_REFERENCE_SAMPLE = "da"
LOUDNESS_FRAME_SECONDS = 0.020
LOUDNESS_HOP_SECONDS = 0.010
LOUDNESS_GATE_BELOW_PEAK_DB = -28.0
LOUDNESS_ABSOLUTE_GATE_DBFS = -50.0
PITCH_FRAME_SIZE = 1536
SUSTAIN_REGION_CONFIG = {
    "mi": {
        "regionStart": 0.245,
        "regionEnd": 0.345,
        "frame": 0.070,
        "overlap": 0.035,
        "search": 0.008,
        "wrapBlend": 0.028,
        "textureDuration": 12.11,
        "seed": 0.29,
        "preferFrameEntry": True,
    }
}


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


def active_rms(samples: np.ndarray, sample_rate: int) -> float:
    """Return gated active-frame RMS across all channels.

    The relative gate removes leading/trailing silence while the absolute gate
    prevents very quiet metadata/noise tails from influencing short effects.
    """
    frame_size = max(1, round(sample_rate * LOUDNESS_FRAME_SECONDS))
    hop_size = max(1, round(sample_rate * LOUDNESS_HOP_SECONDS))
    if len(samples) < frame_size:
        samples = np.pad(samples, ((0, frame_size - len(samples)), (0, 0)))

    frame_levels = []
    for start in range(0, len(samples) - frame_size + 1, hop_size):
        frame = samples[start : start + frame_size]
        frame_levels.append(float(np.sqrt(np.mean(frame * frame))))
    levels = np.array(frame_levels, dtype=np.float64)
    if not len(levels) or float(np.max(levels)) <= 0:
        raise ValueError("No non-silent loudness frames found")

    relative_gate = float(np.max(levels)) * 10.0 ** (
        LOUDNESS_GATE_BELOW_PEAK_DB / 20.0
    )
    absolute_gate = 10.0 ** (LOUDNESS_ABSOLUTE_GATE_DBFS / 20.0)
    active_levels = levels[levels >= max(relative_gate, absolute_gate)]
    if not len(active_levels):
        raise ValueError("No loudness frames survived the active gate")
    return float(np.sqrt(np.mean(active_levels * active_levels)))


def ratio_db(value: float, reference: float) -> float:
    return 20.0 * math.log10(value / reference)


def read_pcm16_wav(path: Path) -> tuple[int, np.ndarray]:
    """Read PCM16 or little-endian IEEE float32 RIFF/WAV audio."""
    payload = path.read_bytes()
    if len(payload) < 12 or payload[:4] != b"RIFF" or payload[8:12] != b"WAVE":
        raise ValueError(f"{path}: expected a little-endian RIFF/WAVE file")

    fmt = None
    data_chunks = []
    offset = 12
    while offset + 8 <= len(payload):
        chunk_id = payload[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", payload, offset + 4)[0]
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_size
        if chunk_end > len(payload):
            raise ValueError(f"{path}: truncated {chunk_id!r} WAV chunk")
        if chunk_id == b"fmt ":
            fmt = payload[chunk_start:chunk_end]
        elif chunk_id == b"data":
            data_chunks.append(payload[chunk_start:chunk_end])
        offset = chunk_end + (chunk_size & 1)

    if fmt is None or len(fmt) < 16 or not data_chunks:
        raise ValueError(f"{path}: missing fmt or data WAV chunk")

    audio_format, channels, sample_rate, _, block_align, bits_per_sample = (
        struct.unpack_from("<HHIIHH", fmt)
    )
    if audio_format == 0xFFFE and len(fmt) >= 40:
        # WAVE_FORMAT_EXTENSIBLE stores the real format tag at the beginning of
        # its sub-format GUID (1 = PCM, 3 = IEEE float).
        audio_format = struct.unpack_from("<H", fmt, 24)[0]
    raw = b"".join(data_chunks)
    if channels <= 0 or block_align <= 0 or len(raw) % block_align:
        raise ValueError(f"{path}: invalid WAV channel or block alignment")

    if audio_format == 1 and bits_per_sample == 16:
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif audio_format == 3 and bits_per_sample == 32:
        samples = np.frombuffer(raw, dtype="<f4").astype(np.float64)
    else:
        raise ValueError(
            f"{path}: unsupported WAV format {audio_format}, {bits_per_sample} bits"
        )
    samples = samples.reshape(-1, channels)
    if not np.all(np.isfinite(samples)):
        raise ValueError(f"{path}: WAV contains non-finite samples")
    return sample_rate, samples


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
    frame_size: int = PITCH_FRAME_SIZE,
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


def serialise_analysis(analysis: PitchAnalysis) -> dict:
    data = asdict(analysis)
    data["frames"] = [asdict(frame) for frame in analysis.frames]
    return data


def safe_file_part(value: str) -> str:
    return value.replace("#", "sharp").replace("/", "-")


def analyse_sustain_region(
    analysis: PitchAnalysis,
    sample_rate: int,
    config: dict,
) -> dict:
    region_span = config["regionEnd"] - config["regionStart"]
    if region_span <= config["frame"] + 2.0 * config["search"]:
        raise ValueError("Sustain region is too short for its frame/search settings")
    if config["overlap"] <= 0 or config["overlap"] >= config["frame"]:
        raise ValueError("Sustain overlap must be between zero and the frame length")
    if config["wrapBlend"] >= config["frame"]:
        raise ValueError("Sustain wrap blend must be shorter than the frame length")

    latest_frame_start = config["regionEnd"] - PITCH_FRAME_SIZE / sample_rate
    frames = [
        frame
        for frame in analysis.frames
        if config["regionStart"] <= frame.time_seconds <= latest_frame_start
        and frame.confidence >= 0.72
    ]
    if len(frames) < 8:
        raise ValueError("Sustain region has too few confident pitch frames")

    midis = np.array([frame.midi for frame in frames], dtype=np.float64)
    levels = np.array([frame.rms for frame in frames], dtype=np.float64)
    confidences = np.array(
        [frame.confidence for frame in frames], dtype=np.float64
    )
    pitch_span_cents = float((np.max(midis) - np.min(midis)) * 100.0)
    rms_span_db = ratio_db(float(np.max(levels)), float(np.min(levels)))
    if pitch_span_cents > 30.0:
        raise ValueError(
            f"Sustain region pitch span is too wide: {pitch_span_cents:.2f} cents"
        )
    if rms_span_db > 4.0:
        raise ValueError(
            f"Sustain region level span is too wide: {rms_span_db:.2f} dB"
        )
    if float(np.min(confidences)) < 0.80:
        raise ValueError("Sustain region contains a low-confidence pitch frame")

    return {
        "config": config,
        "frame_count": len(frames),
        "median_midi": float(np.median(midis)),
        "pitch_span_cents": pitch_span_cents,
        "pitch_standard_deviation_cents": float(np.std(midis) * 100.0),
        "rms_span_db": rms_span_db,
        "mean_confidence": float(np.mean(confidences)),
        "minimum_confidence": float(np.min(confidences)),
    }


def run(args: argparse.Namespace) -> int:
    audio_dir = args.audio_dir.resolve()
    output_path = args.output.resolve()
    temp_dir = args.temp_dir.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir.mkdir(parents=True, exist_ok=True)

    sources: dict[str, tuple[int, np.ndarray, PitchAnalysis]] = {}
    for sample_name in SAMPLE_NAMES:
        relative_path = SAMPLE_SOURCE_FILES.get(sample_name, Path(f"{sample_name}.wav"))
        path = audio_dir / relative_path
        sample_rate, samples = read_pcm16_wav(path)
        sources[sample_name] = (
            sample_rate,
            samples,
            analyze_pitch(samples, sample_rate),
        )

    source_active_rms = {
        sample_name: active_rms(samples, sample_rate)
        for sample_name, (sample_rate, samples, _) in sources.items()
    }
    loudness_target_rms = source_active_rms[LOUDNESS_REFERENCE_SAMPLE]
    sample_gain = {
        sample_name: loudness_target_rms / rms
        for sample_name, rms in source_active_rms.items()
    }
    sustain_regions = {
        sample_name: analyse_sustain_region(
            sources[sample_name][2],
            sources[sample_name][0],
            config,
        )
        for sample_name, config in SUSTAIN_REGION_CONFIG.items()
    }

    mappings = []
    worst_error_cents = 0.0
    worst_loudness_error_db = 0.0
    for sample_name in SAMPLE_NAMES:
        sample_rate, samples, source_analysis = sources[sample_name]
        targets = FIXED_TARGET_MIDI[sample_name]

        for tier_index, tier_name in enumerate(TIER_NAMES):
            target_midi = targets[tier_index]
            if target_midi % 12 not in MINOR_PENTATONIC_PITCH_CLASSES:
                raise ValueError(f"{sample_name}/{tier_name} is outside A minor pentatonic")

            rate = 2.0 ** (
                (target_midi - source_analysis.anchor_midi) / 12.0
            )
            rendered = playback_rate_resample(samples, rate)
            rendered_analysis = analyze_pitch(rendered, sample_rate)
            target_note = note_label(float(target_midi))[0]
            target_hz = hz_from_midi(float(target_midi))
            error_cents = (
                rendered_analysis.anchor_midi - float(target_midi)
            ) * 100.0
            worst_error_cents = max(worst_error_cents, abs(error_cents))
            rendered_active_rms = active_rms(rendered, sample_rate)
            calibrated_active_rms = rendered_active_rms * sample_gain[sample_name]
            loudness_error_db = ratio_db(
                calibrated_active_rms, loudness_target_rms
            )
            worst_loudness_error_db = max(
                worst_loudness_error_db, abs(loudness_error_db)
            )

            if args.write_wavs:
                filename = (
                    f"{sample_name}_{tier_index + 1}-{tier_name}_"
                    f"{safe_file_part(target_note)}_rate-{rate:.8f}.wav"
                )
                write_pcm16_wav(temp_dir / filename, sample_rate, rendered)

            mappings.append(
                {
                    "sfx_id": SAMPLE_TO_SFX[sample_name],
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
                    "sample_gain": sample_gain[sample_name],
                    "remeasured_active_rms": rendered_active_rms,
                    "calibrated_active_rms": calibrated_active_rms,
                    "loudness_error_db": loudness_error_db,
                    "remeasured_voiced_min_hz": rendered_analysis.voiced_min_hz,
                    "remeasured_voiced_max_hz": rendered_analysis.voiced_max_hz,
                }
            )

    piano_mappings = []
    worst_piano_error_cents = 0.0
    worst_piano_loudness_error_db = 0.0
    for sample_name in SAMPLE_NAMES:
        sample_rate, samples, source_analysis = sources[sample_name]
        for key_index, target_midi in enumerate(PIANO_TARGET_MIDI):
            rate = 2.0 ** (
                (target_midi - source_analysis.anchor_midi) / 12.0
            )
            rendered = playback_rate_resample(samples, rate)
            rendered_analysis = analyze_pitch(rendered, sample_rate)
            target_note = note_label(float(target_midi))[0]
            target_hz = hz_from_midi(float(target_midi))
            error_cents = (
                rendered_analysis.anchor_midi - float(target_midi)
            ) * 100.0
            worst_piano_error_cents = max(
                worst_piano_error_cents, abs(error_cents)
            )
            rendered_active_rms = active_rms(rendered, sample_rate)
            calibrated_active_rms = rendered_active_rms * sample_gain[sample_name]
            loudness_error_db = ratio_db(
                calibrated_active_rms, loudness_target_rms
            )
            worst_piano_loudness_error_db = max(
                worst_piano_loudness_error_db, abs(loudness_error_db)
            )

            if args.write_wavs:
                filename = (
                    f"{sample_name}_piano-{key_index + 1}_"
                    f"{safe_file_part(target_note)}_rate-{rate:.8f}.wav"
                )
                write_pcm16_wav(temp_dir / filename, sample_rate, rendered)

            piano_mappings.append(
                {
                    "sfx_id": SAMPLE_TO_SFX[sample_name],
                    "sample": sample_name,
                    "key_index": key_index,
                    "source_anchor_hz": source_analysis.anchor_hz,
                    "source_anchor_midi": source_analysis.anchor_midi,
                    "target_note": target_note,
                    "target_hz": target_hz,
                    "target_midi": target_midi,
                    "playback_rate": rate,
                    "remeasured_hz": rendered_analysis.anchor_hz,
                    "remeasured_midi": rendered_analysis.anchor_midi,
                    "target_error_cents": error_cents,
                    "sample_gain": sample_gain[sample_name],
                    "remeasured_active_rms": rendered_active_rms,
                    "calibrated_active_rms": calibrated_active_rms,
                    "loudness_error_db": loudness_error_db,
                    "remeasured_voiced_min_hz": rendered_analysis.voiced_min_hz,
                    "remeasured_voiced_max_hz": rendered_analysis.voiced_max_hz,
                }
            )

    report = {
        "method": {
            "detector": "frame-wise YIN",
            "anchor": "RMS × confidence weighted median of voiced-frame MIDI",
            "a4_hz": A4_HZ,
            "scale": "A minor pentatonic: A, C, D, E, G",
            "piano_scale": "C major white keys: C4, D4, E4, F4, G4, A4, B4, C5",
            "tier_rule": "fixed target MIDI per sample and screen key",
            "nearest_minor_tier_index": 2,
            "loudness": (
                "20 ms gated active RMS; fixed per-sample gain referenced to da.wav"
            ),
        },
        "sfx_sample_sets": SFX_SAMPLE_SETS,
        "source_files": {
            name: str(SAMPLE_SOURCE_FILES.get(name, Path(f"{name}.wav"))).replace(
                "\\", "/"
            )
            for name in SAMPLE_NAMES
        },
        "sources": {
            name: serialise_analysis(values[2]) for name, values in sources.items()
        },
        "loudness": {
            "reference_sample": LOUDNESS_REFERENCE_SAMPLE,
            "target_active_rms": loudness_target_rms,
            "gate_below_peak_db": LOUDNESS_GATE_BELOW_PEAK_DB,
            "absolute_gate_dbfs": LOUDNESS_ABSOLUTE_GATE_DBFS,
            "source_active_rms": source_active_rms,
            "sample_gain": sample_gain,
        },
        "sustain_regions": sustain_regions,
        "mappings": mappings,
        "piano_mappings": piano_mappings,
        "worst_transposed_target_error_cents": worst_error_cents,
        "worst_piano_target_error_cents": worst_piano_error_cents,
        "worst_transposed_loudness_error_db": worst_loudness_error_db,
        "worst_piano_loudness_error_db": worst_piano_loudness_error_db,
    }
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("Source pitch anchors")
    for sample_name, (_, _, analysis) in sources.items():
        print(
            f"  {sample_name:5s} {analysis.anchor_hz:8.3f} Hz  "
            f"MIDI {analysis.anchor_midi:8.4f}  "
            f"{analysis.nearest_note} {analysis.cents_from_note:+6.2f} cents  "
            f"voiced {analysis.voiced_min_hz:.2f}..{analysis.voiced_max_hz:.2f} Hz  "
            f"active RMS {source_active_rms[sample_name]:.6f}  "
            f"gain {sample_gain[sample_name]:.6f}"
        )
    print(f"Verified mappings: {len(mappings)}")
    print(f"Worst transposed target error: {worst_error_cents:.3f} cents")
    print(f"Verified piano mappings: {len(piano_mappings)}")
    print(f"Worst piano target error: {worst_piano_error_cents:.3f} cents")
    print(
        f"Worst normal-mode loudness error: {worst_loudness_error_db:.3f} dB"
    )
    print(
        f"Worst piano-mode loudness error: {worst_piano_loudness_error_db:.3f} dB"
    )
    for sample_name, sustain in sustain_regions.items():
        print(
            f"Sustain {sample_name}: pitch span "
            f"{sustain['pitch_span_cents']:.3f} cents, level span "
            f"{sustain['rms_span_db']:.3f} dB, confidence "
            f"{sustain['mean_confidence']:.3f}"
        )
    print(f"Report: {output_path}")
    if args.write_wavs:
        print(f"Rendered verification WAVs: {temp_dir}")

    worst_combined_error = max(worst_error_cents, worst_piano_error_cents)
    worst_loudness_error = max(
        worst_loudness_error_db, worst_piano_loudness_error_db
    )
    return 1 if (
        worst_combined_error > args.strict_cents
        or worst_loudness_error > args.strict_loudness_db
    ) else 0


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
    parser.add_argument(
        "--strict-loudness-db",
        type=float,
        default=1.0,
        help="Exit nonzero if calibrated active RMS differs by more.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
