"""Managed sidecar client and lifecycle controller for ACE-Step 1.5.

Keeps ACE-Step 1.5 isolated in ``integrations/ace-step/ACE-Step-1.5`` with its
own ``uv`` virtual environment while exposing typed async helpers for
``backend/api/routers/music.py``.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("omnivoice.music")

REPO_ROOT = Path(__file__).resolve().parents[2]
ACESTEP_DIR = REPO_ROOT / "integrations" / "ace-step" / "ACE-Step-1.5"
ACESTEP_VENV = ACESTEP_DIR / ".venv"
DEFAULT_ACESTEP_URL = os.environ.get("ACESTEP_API_URL", "http://127.0.0.1:8001").rstrip("/")

_sidecar_proc: subprocess.Popen[bytes] | None = None


def is_installed() -> bool:
    """Return True when the ACE-Step 1.5 checkout and its .venv exist."""
    return ACESTEP_DIR.is_dir() and ACESTEP_VENV.is_dir()


def _is_proc_running() -> bool:
    return _sidecar_proc is not None and _sidecar_proc.poll() is None


async def check_health_details(base_url: str = DEFAULT_ACESTEP_URL) -> tuple[bool, str | None, dict[str, Any]]:
    """Probe the ACE-Step /health endpoint and return parsed model/LM initialization details."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{base_url}/health")
            if resp.status_code == 200:
                body = resp.json()
                data = body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), dict) else body
                return True, None, data if isinstance(data, dict) else {}
            return False, f"HTTP {resp.status_code}", {}
    except Exception as exc:  # noqa: BLE001
        return False, str(exc), {}


async def check_health(base_url: str = DEFAULT_ACESTEP_URL) -> tuple[bool, str | None]:
    """Probe the ACE-Step /health endpoint."""
    healthy, err, _ = await check_health_details(base_url)
    return healthy, err


async def get_status(base_url: str = DEFAULT_ACESTEP_URL) -> dict[str, Any]:
    """Return installation, process, and HTTP health status."""
    installed = is_installed()
    if installed:
        healthy, health_error, details = await check_health_details(base_url)
    else:
        healthy, health_error, details = False, "not_installed", {}
    return {
        "installed": installed,
        "running": healthy or _is_proc_running(),
        "healthy": healthy,
        "llm_initialized": bool(details.get("llm_initialized", False)),
        "models_initialized": bool(details.get("models_initialized", False)),
        "loaded_model": details.get("loaded_model"),
        "loaded_lm_model": details.get("loaded_lm_model"),
        "managed_pid": _sidecar_proc.pid if _is_proc_running() else None,
        "api_url": base_url,
        "repo_path": str(ACESTEP_DIR),
        "error": None if healthy else health_error,
    }


def start_sidecar(port: int = 8001, host: str = "127.0.0.1") -> dict[str, Any]:
    """Launch ``uv run acestep-api`` in the isolated ACE-Step directory."""
    global _sidecar_proc
    if not is_installed():
        raise FileNotFoundError(f"ACE-Step 1.5 is not installed at {ACESTEP_DIR}")
    if _is_proc_running():
        return {"started": False, "already_running": True, "pid": _sidecar_proc.pid}

    uv_bin = shutil.which("uv") or "uv"
    cmd = [uv_bin, "run", "acestep-api", "--host", host, "--port", str(port)]
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    log_dir = REPO_ROOT / "integrations" / "ace-step" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = open(log_dir / "acestep-api.log", "ab")

    env = os.environ.copy()
    env.setdefault("ACESTEP_INIT_LLM", "true")
    env.setdefault("ACESTEP_LM_MODEL_PATH", "acestep-5Hz-lm-0.6B")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if sys.platform == "win32":
        env.setdefault("ACESTEP_LM_BACKEND", "pt")
        env.setdefault("ACESTEP_LM_OFFLOAD_TO_CPU", "true")

    _sidecar_proc = subprocess.Popen(
        cmd,
        cwd=str(ACESTEP_DIR),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        creationflags=creationflags,
    )
    logger.info("Started ACE-Step 1.5 sidecar (pid=%s)", _sidecar_proc.pid)
    return {"started": True, "already_running": False, "pid": _sidecar_proc.pid}


def stop_sidecar() -> dict[str, Any]:
    """Terminate the managed ACE-Step 1.5 sidecar process if running."""
    global _sidecar_proc
    if not _is_proc_running():
        _sidecar_proc = None
        return {"stopped": False, "was_running": False}
    assert _sidecar_proc is not None
    pid = _sidecar_proc.pid
    _sidecar_proc.terminate()
    try:
        _sidecar_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _sidecar_proc.kill()
    _sidecar_proc = None
    logger.info("Stopped ACE-Step 1.5 sidecar (pid=%s)", pid)
    return {"stopped": True, "was_running": True, "pid": pid}


async def _stage_audio_in_temp(raw_path: str) -> str:
    """Ensure local audio files sit inside tempfile.gettempdir() as readable audio for ACE-Step."""
    if not raw_path:
        return raw_path
    src = Path(raw_path)
    if not src.is_file():
        return raw_path
    temp_root = Path(tempfile.gettempdir()).resolve()
    try:
        resolved = src.resolve()
        if resolved.is_relative_to(temp_root) and resolved.suffix.lower() in {".wav", ".flac", ".mp3"}:
            return str(resolved)
    except Exception:  # noqa: BLE001
        pass

    # Convert non-WAV formats via FFmpeg so ACE-Step's soundfile always succeeds
    staged_wav = temp_root / f"acestep_input_{uuid.uuid4().hex[:10]}.wav"
    if src.suffix.lower() != ".wav":
        try:
            from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

            ffmpeg = find_ffmpeg()
            if ffmpeg:
                rc, _, _ = await run_ffmpeg(
                    [
                        ffmpeg,
                        "-y",
                        "-i",
                        str(src),
                        "-ar",
                        "48000",
                        "-ac",
                        "2",
                        "-c:a",
                        "pcm_s16le",
                        str(staged_wav),
                    ],
                    timeout=60.0,
                )
                if rc == 0 and staged_wav.is_file() and staged_wav.stat().st_size > 0:
                    return str(staged_wav)
        except Exception as exc:  # noqa: BLE001
            logger.debug("FFmpeg normalization for ACE-Step input skipped (%s); copying raw file", exc)

    staged = temp_root / f"acestep_input_{uuid.uuid4().hex[:10]}{src.suffix or '.mp3'}"
    shutil.copy2(src, staged)
    return str(staged)


async def release_task(payload: dict[str, Any], base_url: str = DEFAULT_ACESTEP_URL) -> dict[str, Any]:
    """Submit a generation task to ACE-Step ``POST /release_task``."""
    outbound = dict(payload)
    if sys.platform == "win32":
        outbound.setdefault("lm_backend", "pt")
    for key in ("src_audio_path", "reference_audio_path"):
        val = outbound.get(key)
        if isinstance(val, str) and val.strip():
            outbound[key] = await _stage_audio_in_temp(val.strip())

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{base_url}/release_task", json=outbound)
        if resp.status_code >= 400:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
        return resp.json()


async def query_result(task_id: str, base_url: str = DEFAULT_ACESTEP_URL) -> dict[str, Any]:
    """Query a task via ACE-Step ``POST /query_result``."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{base_url}/query_result", json={"task_id_list": [task_id]})
        resp.raise_for_status()
        return resp.json()


async def download_audio_to_outputs(
    remote_audio_path: str,
    outputs_dir: Path,
    base_url: str = DEFAULT_ACESTEP_URL,
) -> Path:
    """Download an audio file from ACE-Step ``/v1/audio`` into VoiceStudio's OUTPUTS_DIR."""
    outputs_dir.mkdir(parents=True, exist_ok=True)
    parsed = urllib.parse.urlparse(remote_audio_path)
    qs = urllib.parse.parse_qs(parsed.query)
    raw_target = qs.get("path", [parsed.path or remote_audio_path])[0]
    ext = Path(raw_target).suffix or ".mp3"
    local_name = f"music_{uuid.uuid4().hex[:12]}{ext}"
    local_path = outputs_dir / local_name

    base = base_url.rstrip("/")
    if remote_audio_path.startswith(("http://", "https://")):
        download_url = remote_audio_path
    elif remote_audio_path.startswith("/v1/audio"):
        download_url = f"{base}{remote_audio_path}"
    else:
        encoded = urllib.parse.quote(remote_audio_path, safe="")
        download_url = f"{base}/v1/audio?path={encoded}"

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(download_url)
        resp.raise_for_status()
        local_path.write_bytes(resp.content)
    return local_path


def read_sidecar_logs(max_lines: int = 80) -> list[str]:
    """Return the tail of the ACE-Step sidecar log file."""
    log_path = REPO_ROOT / "integrations" / "ace-step" / "logs" / "acestep-api.log"
    if not log_path.is_file():
        return []
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        return lines[-max_lines:]
    except Exception:  # noqa: BLE001
        return []


def separate_stems_sync(
    input_path: Path,
    outputs_dir: Path,
    mode: str = "2stems",
) -> dict[str, Path]:
    """Run VoiceStudio's installed Demucs (2-stems, 4-stems, or 6-stems) on a music file."""
    import tempfile

    outputs_dir.mkdir(parents=True, exist_ok=True)
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    model_name = "htdemucs_6s" if mode == "6stems" else "htdemucs"
    with tempfile.TemporaryDirectory(prefix="music_demucs_", dir=str(outputs_dir)) as tmp:
        cmd = [sys.executable, "-m", "demucs"]
        if mode == "2stems":
            cmd.append("--two-stems=vocals")
        cmd += ["-n", model_name, "-o", tmp, str(input_path)]

        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
            creationflags=creationflags,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr[-500:] or proc.stdout[-500:] or "Demucs failed")

        stem_dir = Path(tmp) / model_name / input_path.stem
        uid = uuid.uuid4().hex[:10]
        if mode == "2stems":
            expected = [("vocals", "vocals.wav"), ("instrumental", "no_vocals.wav")]
        elif mode == "6stems":
            expected = [
                ("vocals", "vocals.wav"),
                ("drums", "drums.wav"),
                ("bass", "bass.wav"),
                ("guitar", "guitar.wav"),
                ("piano", "piano.wav"),
                ("other", "other.wav"),
            ]
        else:
            expected = [
                ("vocals", "vocals.wav"),
                ("drums", "drums.wav"),
                ("bass", "bass.wav"),
                ("other", "other.wav"),
            ]
        results: dict[str, Path] = {}
        for key, fname in expected:
            src = stem_dir / fname
            if not src.is_file():
                raise FileNotFoundError(f"Demucs did not produce {fname}")
            dst = outputs_dir / f"stem_{key}_{uid}.wav"
            shutil.move(str(src), str(dst))
            results[key] = dst
        return results
