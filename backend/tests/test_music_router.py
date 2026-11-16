"""Unit tests for the ACE-Step 1.5 hybrid music router and sidecar helpers."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("HF_HOME", str(Path(tempfile.gettempdir()) / "hf_test_cache"))
os.environ.setdefault("HF_HUB_CACHE", str(Path(tempfile.gettempdir()) / "hf_test_cache" / "hub"))
os.environ.setdefault("OMNIVOICE_DATA_DIR", str(Path(tempfile.gettempdir()) / "omnivoice_test_data"))

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import HTTPException
import pytest

from api.routers.music import (  # noqa: E402
    MultitrackItem,
    _analyze_audio_acoustics_sync,
    _apply_vocal_gender_prompt,
    _build_multitrack_filter,
    _extract_analysis,
    _extract_audio_paths,
    _inherit_track_meta,
    _list_music_library_sync,
    _probe_audio_duration,
    _read_track_meta,
    _resolve_output_file,
    _store_bounded,
    _strip_instrumental_only_clauses,
    _write_track_meta,
)
from services import music_sidecar  # noqa: E402


def test_extract_audio_paths_from_list_and_json_string() -> None:
    items = [{"file": "/tmp/song_1.mp3"}, {"other": "ignored"}, {"file": "/tmp/song_2.wav"}]
    assert _extract_audio_paths(items) == ["/tmp/song_1.mp3", "/tmp/song_2.wav"]
    assert _extract_audio_paths(json.dumps(items)) == ["/tmp/song_1.mp3", "/tmp/song_2.wav"]
    assert _extract_audio_paths("not-json") == []
    assert _extract_audio_paths(None) == []


def test_extract_analysis_parses_metas_and_top_level() -> None:
    payload = json.dumps(
        [
            {
                "metas": {
                    "caption": "bossa nova acoustic",
                    "lyrics": "[Verse]\nSol e mar",
                    "bpm": 96,
                    "duration": 32,
                    "vocal_language": "pt",
                }
            }
        ]
    )
    parsed = _extract_analysis(payload)
    assert parsed == {
        "prompt": "bossa nova acoustic",
        "lyrics": "[Verse]\nSol e mar",
        "bpm": 96,
        "duration": 32,
        "vocal_language": "pt",
    }
    assert _extract_analysis("invalid") is None


def test_resolve_output_file_rejects_missing_or_traversal() -> None:
    with pytest.raises(HTTPException) as exc:
        _resolve_output_file("/audio/../../nonexistent_secret.wav")
    assert exc.value.status_code == 404


def test_read_sidecar_logs_handles_missing_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(music_sidecar, "REPO_ROOT", tmp_path)
    assert music_sidecar.read_sidecar_logs() == []


def test_download_audio_to_outputs_avoids_double_wrapping_v1_audio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio
    requested_urls: list[str] = []

    class FakeResp:
        content = b"ID3-fake-mp3"

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            return None

        async def get(self, url: str) -> FakeResp:
            requested_urls.append(url)
            return FakeResp()

    monkeypatch.setattr(music_sidecar.httpx, "AsyncClient", FakeClient)

    async def _run() -> tuple[Path, Path]:
        out1 = await music_sidecar.download_audio_to_outputs(
            "/v1/audio?path=C%3A%5Coutputs%5Csong.mp3", tmp_path, base_url="http://127.0.0.1:8001"
        )
        out2 = await music_sidecar.download_audio_to_outputs(
            r"C:\outputs\raw.wav", tmp_path, base_url="http://127.0.0.1:8001"
        )
        return out1, out2

    out1, out2 = asyncio.run(_run())

    assert requested_urls[0] == "http://127.0.0.1:8001/v1/audio?path=C%3A%5Coutputs%5Csong.mp3"
    assert requested_urls[1] == "http://127.0.0.1:8001/v1/audio?path=C%3A%5Coutputs%5Craw.wav"
    assert out1.suffix == ".mp3"
    assert out2.suffix == ".wav"
    assert out1.read_bytes() == b"ID3-fake-mp3"


def test_strip_instrumental_only_clauses_preserves_arrangements() -> None:
    prompt = "pop rock, build full band instrumental arrangement, purely instrumental, no vocals"
    cleaned = _strip_instrumental_only_clauses(prompt)
    assert "build full band instrumental arrangement" in cleaned
    assert "purely instrumental" not in cleaned
    assert "no vocals" not in cleaned


def test_apply_vocal_gender_prompt_respects_word_boundaries() -> None:
    assert "female lead vocals" in _apply_vocal_gender_prompt("pop, female vocals", "female")
    p_male = _apply_vocal_gender_prompt("rock, female vocals, woman singing", "male")
    assert "female" not in p_male.lower() and "woman" not in p_male.lower()
    assert "male lead vocals" in p_male


def test_multitrack_filter_normalizes_48k_stereo_before_pitch_shift() -> None:
    item = MultitrackItem(audio_url="/audio/a.wav", volume=0.9, pan=-0.5, pitch_semitones=2.0, start_sec=1.2)
    chain, lbl = _build_multitrack_filter(0, item)
    assert lbl == "[t0]"
    assert chain.startswith("[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.900,")
    assert "asetrate=48000*" in chain and ",aresample=48000,atempo=" in chain
    assert "pan=stereo|c0=1.000*c0|c1=0.500*c1" in chain
    assert chain.endswith("adelay=1200|1200[t0]")


def test_acoustics_and_meta_inheritance_and_stem_library_filtering(tmp_path: Path) -> None:
    import numpy as np
    import soundfile as sf

    sr = 48000
    t = np.linspace(0, 10.0, int(sr * 10.0), endpoint=False, dtype=np.float32)
    beat_sec = 60.0 / 128.0
    beat_idx = np.floor(t / beat_sec).astype(int)
    pulse = np.exp(-(t - beat_idx * beat_sec) / 0.04).astype(np.float32)
    kick = np.where((beat_idx % 2) == 0, 0.9 * np.sin(2 * np.pi * 75.0 * t), 0.0).astype(np.float32)
    snare = np.where((beat_idx % 2) == 1, 0.7 * np.sin(2 * np.pi * 6500.0 * t), 0.0).astype(np.float32)

    src_wav = tmp_path / "acestep_long_abc123.wav"
    dst_wav = tmp_path / "music_master_xyz.wav"
    raw_stem = tmp_path / "music_vocals_old.wav"
    new_stem = tmp_path / "stem_vocals_new.wav"
    sf.write(str(src_wav), pulse * (kick + snare), sr)
    sf.write(str(dst_wav), np.zeros(int(sr * 4.5), dtype=np.float32), sr)
    sf.write(str(raw_stem), np.zeros(int(sr * 2.0), dtype=np.float32), sr)
    sf.write(str(new_stem), np.zeros(int(sr * 2.0), dtype=np.float32), sr)

    acoustics = _analyze_audio_acoustics_sync(str(src_wav))
    assert 122 <= (acoustics["bpm"] or 0) <= 134
    assert acoustics["warm_bass"] is True
    assert acoustics["bright_highs"] is True
    assert acoustics["suggested_instrumental"] is True

    _write_track_meta(src_wav, {"title": "Longa", "prompt": "groove", "duration": -1.0, "rating": "like", "listened": True})
    probed = _probe_audio_duration(dst_wav)
    assert probed == 4.5
    _inherit_track_meta(src_wav, dst_wav, probed)
    meta = _read_track_meta(dst_wav)
    assert meta["title"] == "Longa" and meta["duration"] == 4.5
    assert "rating" not in meta and "listened" not in meta

    tracks = _list_music_library_sync(tmp_path, limit=20)
    names = {t_item["filename"] for t_item in tracks}
    assert "acestep_long_abc123.wav" in names
    assert "music_master_xyz.wav" in names
    assert "music_vocals_old.wav" not in names
    assert "stem_vocals_new.wav" not in names


def test_store_bounded_evicts_oldest_entries() -> None:
    cache: dict[str, int] = {}
    for idx in range(5):
        _store_bounded(cache, f"k{idx}", idx, max_entries=3)
    assert list(cache.keys()) == ["k2", "k3", "k4"]
    assert list(cache.values()) == [2, 3, 4]
