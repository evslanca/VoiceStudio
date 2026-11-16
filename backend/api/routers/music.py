"""Hybrid Music Generation router (ACE-Step 1.5 sidecar bridge).

Exposes ``/api/music/*`` endpoints so the VoiceStudio UI can manage the
isolated ACE-Step 1.5 sidecar, generate full songs or covers, upload source
audio, split vocals/instrumental with VoiceStudio's Demucs, and play the
resulting audio directly from VoiceStudio's ``/audio`` mount.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import shutil
import tempfile
import uuid
import wave
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from api.dependencies import require_consumer_reads_admin_writes
from core.config import OUTPUTS_DIR
from services import music_sidecar

router = APIRouter(dependencies=[Depends(require_consumer_reads_admin_writes)])
logger = logging.getLogger("omnivoice.music")
_TASK_META: dict[str, dict] = {}
_ANALYZE_META: dict[str, str] = {}
_LOCAL_ANALYZE_RESULTS: dict[str, dict] = {}
_LONG_TASK_JOBS: dict[str, dict] = {}
_LONG_SINGLE_PASS_LIMIT_SEC = 115.0
_LONG_CONTEXT_OVERLAP_SEC = 18.0


def _store_bounded(cache: dict, key: str, value: object, max_entries: int = 200) -> None:
    """Insert an item into an in-memory tracking dict and evict the oldest entries above `max_entries`."""
    cache[key] = value
    while len(cache) > max_entries:
        oldest_key = next(iter(cache))
        cache.pop(oldest_key, None)


def _meta_path_for(audio_path: Path) -> Path:
    return audio_path.with_name(f"{audio_path.name}.meta.json")


def _read_track_meta(audio_path: Path) -> dict:
    meta_path = _meta_path_for(audio_path)
    if not meta_path.is_file():
        return {}
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _write_track_meta(audio_path: Path, updates: dict) -> dict:
    current = _read_track_meta(audio_path)
    for key, val in updates.items():
        if key == "rating" and val == "none":
            current.pop("rating", None)
        elif val is not None:
            current[key] = val
    try:
        _meta_path_for(audio_path).write_text(
            json.dumps(current, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as exc:
        logger.warning("Failed to write track metadata for %s: %s", audio_path.name, exc)
    return current


def _probe_audio_duration(audio_path: Path) -> float | None:
    """Measure exact audio duration in seconds from local audio headers."""
    try:
        import soundfile as sf

        info = sf.info(str(audio_path))
        if info.frames > 0 and info.samplerate > 0:
            return round(float(info.frames / info.samplerate), 1)
    except Exception:  # noqa: BLE001
        pass
    try:
        if audio_path.suffix.lower() == ".wav":
            import wave

            with wave.open(str(audio_path), "rb") as wf:
                sr = wf.getframerate()
                if sr > 0:
                    return round(float(wf.getnframes() / sr), 1)
    except Exception:  # noqa: BLE001
        pass
    return None


def _inherit_track_meta(src: Path, dst: Path, probed_duration: float | None = None) -> None:
    """Copy descriptive track metadata onto a derived audio file with updated duration."""
    src_meta = _read_track_meta(src)
    updates = {
        k: v
        for k, v in src_meta.items()
        if k not in {"rating", "listened"} and v is not None
    }
    if probed_duration is not None and probed_duration > 0:
        updates["duration"] = probed_duration
    elif "duration" in updates and (not isinstance(updates["duration"], (int, float)) or updates["duration"] <= 0):
        updates.pop("duration", None)
    if updates:
        _write_track_meta(dst, updates)


def _preferences_path() -> Path:
    return Path(OUTPUTS_DIR).resolve() / ".music_preferences.json"


_PT_CHARS_RE = re.compile(r"[ãõçáéíóúâêôà]", re.IGNORECASE)
_ES_CHARS_RE = re.compile(r"[ñ¿¡]", re.IGNORECASE)
_EN_WORDS = {
    "the", "and", "you", "your", "love", "night", "heart", "with", "this",
    "that", "for", "down", "street", "feel", "sky", "never", "always", "dream",
    "away", "light", "tonight", "baby", "forever", "believe", "time", "world",
}
_PT_WORDS = {
    "que", "não", "nao", "com", "você", "voce", "meu", "minha", "nos", "nós",
    "para", "pra", "por", "uma", "amor", "noite", "coração", "coracao", "vida",
    "sempre", "nunca", "tudo", "mundo", "olhar", "saudade", "sonho", "dia",
}
_ES_WORDS = {
    "que", "con", "contigo", "quiero", "siempre", "noche", "corazon", "corazón",
    "amor", "vida", "nunca", "todo", "mundo", "para", "por", "una", "mi", "tu",
}

_GENRE_BPM_MAP: tuple[tuple[tuple[str, ...], int], ...] = (
    (("drum and bass", "dnb", "jungle"), 172),
    (("trap", "drill"), 140),
    (("piseiro",), 136),
    (("techno", "trance", "hardstyle"), 134),
    (("rock", "punk", "metal"), 132),
    (("funk carioca", "baile funk", "mandelao", "mandelão", "funk"), 130),
    (("house", "tech house", "edm", "dance", "electro"), 124),
    (("pop", "synthpop", "indie pop", "disco"), 116),
    (("forro", "forró", "xote"), 112),
    (("pagode", "samba"), 98),
    (("sertanejo", "arrocha", "brega"), 96),
    (("reggaeton", "dembow"), 95),
    (("bossa nova", "mpb"), 90),
    (("hip hop", "rap", "boom bap", "lo-fi", "lofi"), 88),
    (("ballad", "balada", "acustico", "acústico", "acoustic", "piano", "lento", "slow"), 74),
)


def _detect_vocal_language(lyrics: str, prompt: str, requested_lang: str) -> str:
    """Default to Brazilian Portuguese ('pt'), switching automatically if lyrics/prompt are clearly in another language."""
    sample = (lyrics or "").strip() or (prompt or "").strip()
    if not sample:
        return requested_lang or "pt"
    if _PT_CHARS_RE.search(sample):
        return "pt"
    if _ES_CHARS_RE.search(sample):
        return "es"
    words = set(re.findall(r"[a-zA-Z]+", sample.lower()))
    en_hits = len(words & _EN_WORDS)
    pt_hits = len(words & _PT_WORDS)
    es_hits = len(words & _ES_WORDS)
    if en_hits >= 2 and en_hits > pt_hits and en_hits >= es_hits:
        return "en"
    if es_hits >= 2 and es_hits > pt_hits and es_hits > en_hits:
        return "es"
    if pt_hits >= 1:
        return "pt"
    return requested_lang or "pt"


def _infer_smart_bpm(prompt: str, lyrics: str, requested_bpm: int | None) -> int | None:
    """Infer genre-appropriate BPM when the user left the default 120 BPM."""
    if requested_bpm is not None and requested_bpm != 120:
        return requested_bpm
    combined = f"{prompt} {lyrics}".lower()
    m = re.search(r"\b(\d{2,3})\s*bpm\b", combined)
    if m:
        val = int(m.group(1))
        if 40 <= val <= 220:
            return val
    for keywords, bpm_val in _GENRE_BPM_MAP:
        if any(kw in combined for kw in keywords):
            return bpm_val
    return requested_bpm


_SECTION_HEADER_RE = re.compile(r"^\s*(\[[^\]]+\])\s*$")


def _split_lyric_sections(text: str) -> list[tuple[str, str]]:
    """Parse structured `[Section]` blocks into `(header, body)` tuples."""
    sections: list[tuple[str, str]] = []
    cur_header: str | None = None
    cur_lines: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _SECTION_HEADER_RE.match(line)
        if m:
            if cur_header is not None or cur_lines:
                sections.append((cur_header or "[Verse 1]", "\n".join(cur_lines).strip()))
            cur_header = m.group(1)
            cur_lines = []
        else:
            cur_lines.append(line)
    if cur_header is not None or cur_lines:
        sections.append((cur_header or "[Verse 1]", "\n".join(cur_lines).strip()))
    return sections


def _render_sections(sections: list[tuple[str, str]]) -> str:
    blocks = []
    for hdr, body in sections:
        blocks.append(f"{hdr}\n{body}".strip() if body else hdr)
    return "\n\n".join(blocks)


def _plan_song_structure_for_duration(
    lyrics: str,
    target_duration: float | None,
    *,
    is_instrumental: bool = False,
) -> str:
    """Build or expand `[Intro]/[Verse]/[Chorus]/[Bridge]/[Outro]` anchors across `target_duration`.

    ACE-Step's DiT uses sliding-window attention (~5s local window) anchored via lyrics
    section tokens; songs longer than ~2 minutes lose structure if section tags end early.
    """
    dur = float(target_duration or 30.0)
    if is_instrumental:
        # ACE-Step HTTP /release_task infers `instrumental` strictly via `is_instrumental(lyrics)`,
        # which only matches empty string or `[inst]`/`[instrumental]`. Section cues go in `prompt`.
        return "[Instrumental]"

    cleaned = (lyrics or "").strip()
    if not cleaned:
        if dur < 60.0:
            return "[Verse]\n(vocais expressivos cantando a melodia principal)\n\n[Chorus]\n(refrão melódico marcante)"
        if dur < 105.0:
            return (
                "[Intro - instrumental]\n\n"
                "[Verse 1]\n(vocais expressivos iniciando a melodia principal)\n\n"
                "[Pre-Chorus]\n(crescente melódico emocionante)\n\n"
                "[Chorus]\n(refrão marcante e envolvente)\n\n"
                "[Outro - fade out]"
            )
        scaffold = [
            ("[Intro - instrumental buildup]", ""),
            ("[Verse 1]", "(primeira estrofe cantada com clareza e emoção)"),
            ("[Pre-Chorus]", "(preparação harmônica subindo a energia)"),
            ("[Chorus - full band]", "(refrão principal forte e memorável)"),
            ("[Verse 2]", "(segunda estrofe desenvolvendo o tema musical)"),
            ("[Bridge - melodic shift]", "(ponte contrastante preparando o clímax)"),
            ("[Instrumental Break - solo]", ""),
            ("[Final Chorus - powerful]", "(refrão final com máxima intensidade vocal)"),
            ("[Outro - smooth fade out]", ""),
        ]
        desired = max(5, min(len(scaffold), round(dur / 24.0)))
        if desired < len(scaffold):
            # Keep intro, core arc, and outro proportional
            picked = scaffold[: desired - 1] + [scaffold[-1]]
            return _render_sections(picked)
        return _render_sections(scaffold)

    has_tags = bool(
        re.search(
            r"\[(verse|chorus|bridge|intro|outro|pre-chorus|hook|drop|refrão|verso|instrumental|solo)",
            cleaned,
            re.IGNORECASE,
        )
    )
    if not has_tags:
        lines = [ln.strip() for ln in cleaned.splitlines() if ln.strip()]
        if len(lines) <= 4 and dur < 100.0:
            return "[Verse]\n" + "\n".join(lines)
        # Partition flat lines into natural stanzas
        chunk_sz = 3 if len(lines) >= 9 else max(2, (len(lines) + 1) // 2)
        raw_groups = [lines[i : i + chunk_sz] for i in range(0, len(lines), chunk_sz)]
        tag_cycle = ["[Verse 1]", "[Chorus]", "[Verse 2]", "[Bridge]", "[Final Chorus]"]
        sections = [(tag_cycle[min(idx, len(tag_cycle) - 1)], "\n".join(grp)) for idx, grp in enumerate(raw_groups)]
    else:
        sections = _split_lyric_sections(cleaned)

    if dur < 100.0:
        return _render_sections(sections)

    desired_sections = max(5, min(10, round(dur / 25.0)))
    has_intro = any("intro" in hdr.lower() for hdr, _ in sections)
    has_outro = any("outro" in hdr.lower() for hdr, _ in sections)
    has_break = any(k in hdr.lower() for hdr, _ in sections for k in ("instrumental", "solo", "break"))

    chorus_body = next(
        (body for hdr, body in sections if any(k in hdr.lower() for k in ("chorus", "refrão", "hook")) and body),
        sections[-1][1] if sections else "",
    )

    if not has_intro and len(sections) < desired_sections:
        sections.insert(0, ("[Intro - melodic buildup]", ""))

    if dur >= 140.0 and not has_break and len(sections) < desired_sections:
        insert_at = max(1, len(sections) - (1 if has_outro else 0))
        sections.insert(insert_at, ("[Instrumental Break - solo]", ""))

    while len(sections) < desired_sections - 1 and chorus_body:
        insert_at = max(1, len(sections) - (1 if has_outro else 0))
        has_bridge = any("bridge" in hdr.lower() for hdr, _ in sections)
        tag = "[Chorus - reprise]" if has_bridge else "[Bridge - dynamic build]"
        body = chorus_body if has_bridge else "(variação melódica mantendo o mesmo ritmo e tonalidade)"
        sections.insert(insert_at, (tag, body))

    if not has_outro:
        sections.append(("[Outro - smooth ending]", ""))

    return _render_sections(sections)


def _structure_lyrics_if_needed(lyrics: str, target_duration: float | None = 30.0) -> str:
    """Ensure vocal lyrics have timed `[Verse]/[Chorus]` structure tags appropriate for duration."""
    return _plan_song_structure_for_duration(lyrics, target_duration, is_instrumental=False)


def _estimate_duration_from_lyrics(
    lyrics: str,
    requested_duration: float | None,
    *,
    force_auto: bool = False,
) -> float | None:
    """Auto-calculate song length from lyrics when `Auto` is selected or when default 30s would clip vocals."""
    lines = [
        ln.strip()
        for ln in (lyrics or "").splitlines()
        if ln.strip() and not ln.strip().startswith("[")
    ]
    if force_auto:
        if not lines:
            return None
        return float(min(240.0, max(35.0, round(len(lines) * 3.5 + 14.0))))
    if requested_duration is None or abs(requested_duration - 30.0) > 1.0:
        return requested_duration
    if len(lines) <= 6:
        return requested_duration
    return float(min(240.0, max(30.0, round(len(lines) * 3.0 + 8.0))))


_INST_ONLY_CLAUSE_RE = re.compile(
    r"(?:^\s*instrumental\s*$|purely\s+instrumental|instrumental[\s-]+only|\bno\s+vocals?\b|\bno\s+singing\b|\bsem\s+voz\b|\bsem\s+vocal\b|\bapenas\s+instrumental\b)",
    re.IGNORECASE,
)


def _strip_instrumental_only_clauses(prompt: str, fallback: str = "") -> str:
    """Drop 'instrumental-only' tags for vocal tracks while keeping phrases like 'instrumental arrangement'."""
    kept = [
        part.strip()
        for part in (prompt or "").split(",")
        if part.strip() and not _INST_ONLY_CLAUSE_RE.search(part)
    ]
    return ", ".join(kept) or fallback.strip()


def _apply_vocal_gender_prompt(
    prompt: str,
    vocal_gender: str,
    *,
    is_instrumental: bool = False,
) -> str:
    """Apply explicit male/female lead vocal tags while stripping conflicting gender descriptors."""
    if is_instrumental or vocal_gender not in {"male", "female"}:
        return prompt
    opposite = (
        ("female", "feminina", "feminino", "woman", "mulher", "girl", "soprano", "diva")
        if vocal_gender == "male"
        else ("male", "masculina", "masculino", "man", "homem", "boy", "baritone", "tenor")
    )
    kept = [
        part.strip()
        for part in (prompt or "").split(",")
        if part.strip() and not re.search(rf"\b(?:{'|'.join(opposite)})\b", part, re.IGNORECASE)
    ]
    base = ", ".join(kept) or (prompt or "").strip()
    tag = (
        "male lead vocals, clear baritone or tenor male singing voice"
        if vocal_gender == "male"
        else "female lead vocals, clear expressive female singing voice"
    )
    if tag in base.lower():
        return base
    return f"{tag}, {base}" if base else tag


def _apply_advanced_controls(
    payload: dict,
    *,
    is_turbo: bool,
    effective_thinking: bool,
    exclude_styles: str = "",
    max_mode: bool = False,
    weirdness: int = 50,
    style_influence: int = 50,
    variety: int = 50,
    has_src_audio: bool = False,
) -> None:
    """Translate user-facing studio controls into verified ACE-Step 1.5 inference fields."""
    neg_terms = [t.strip() for t in (exclude_styles or "").split(",") if t.strip()]
    existing_neg = str(payload.get("lm_negative_prompt") or "").strip()
    existing_terms = (
        [t.strip() for t in existing_neg.split(",") if t.strip()]
        if existing_neg and existing_neg != "NO USER INPUT"
        else []
    )
    if neg_terms or existing_terms:
        merged_neg: list[str] = []
        seen_neg: set[str] = set()
        for term in [*neg_terms, *existing_terms]:
            low = term.lower()
            if low not in seen_neg:
                seen_neg.add(low)
                merged_neg.append(term)
        payload["lm_negative_prompt"] = ", ".join(merged_neg)
    if neg_terms:
        cur_prompt = str(payload.get("prompt") or "")
        filtered = [
            part.strip()
            for part in cur_prompt.split(",")
            if part.strip() and not any(term.lower() in part.lower() for term in neg_terms)
        ]
        if filtered:
            payload["prompt"] = ", ".join(filtered)

    w = max(0, min(100, int(weirdness)))
    if w != 50:
        w_factor = (w - 50) / 50.0
        payload["lm_temperature"] = round(max(0.50, min(1.20, 0.85 + 0.30 * w_factor)), 2)
        payload["lm_top_p"] = round(max(0.75, min(0.99, 0.90 + 0.08 * w_factor)), 2)
        if w >= 75:
            payload["infer_method"] = "sde"
        elif w <= 20:
            cur_p = str(payload.get("prompt") or "").strip()
            if cur_p and "clean predictable melody" not in cur_p.lower():
                payload["prompt"] = f"{cur_p}, clean predictable melody, classic structured arrangement"

    s = max(0, min(100, int(style_influence)))
    if s != 50:
        s_factor = (s - 50) / 50.0
        base_g = float(payload.get("guidance_scale") or 7.0)
        payload["guidance_scale"] = round(max(2.5, min(12.0, base_g + 4.0 * s_factor)), 1)
        payload["lm_cfg_scale"] = round(max(1.5, min(4.2, 2.5 + 1.3 * s_factor)), 2)
        if has_src_audio and s >= 75:
            payload["audio_cover_strength"] = min(float(payload.get("audio_cover_strength") or 0.65), 0.65)

    v = max(0, min(100, int(variety)))
    if v >= 70:
        cur_p = str(payload.get("prompt") or "").strip()
        if cur_p and "expressive melodic variations" not in cur_p.lower():
            payload["prompt"] = f"{cur_p}, dynamic arrangement, expressive melodic variations"
        if effective_thinking:
            payload["lm_repetition_penalty"] = max(float(payload.get("lm_repetition_penalty") or 1.0), 1.14)
    elif v <= 25:
        cur_p = str(payload.get("prompt") or "").strip()
        if cur_p and "steady consistent groove" not in cur_p.lower():
            payload["prompt"] = f"{cur_p}, steady consistent groove, minimal arrangement"

    if max_mode:
        payload["use_tiled_decode"] = True
        if float(payload.get("guidance_scale") or 7.0) < 8.0:
            payload["guidance_scale"] = 8.0
        if is_turbo:
            payload["dcw_enabled"] = True
            payload["dcw_mode"] = "double"
            payload["dcw_wavelet"] = "sym8"
        else:
            payload["inference_steps"] = max(int(payload.get("inference_steps") or 32), 60)
            payload["use_adg"] = True
            payload["shift"] = 3.0
        cur_p = str(payload.get("prompt") or "").strip()
        if cur_p and "studio master quality" not in cur_p.lower():
            payload["prompt"] = f"{cur_p}, studio master quality, crisp high dynamic range, balanced mix"


def _tune_payload_for_duration(
    payload: dict,
    *,
    duration: float | None,
    is_turbo: bool,
    effective_thinking: bool,
    steps: int,
) -> None:
    """Apply ACE-Step documented long-form stability parameters without breaking turbo/base constraints."""
    dur = float(duration or 30.0)
    payload["use_tiled_decode"] = True

    if dur >= 100.0:
        cur_prompt = str(payload.get("prompt") or "").strip()
        is_inst_payload = str(payload.get("lyrics") or "").strip().lower() in {"", "[inst]", "[instrumental]"}
        if is_inst_payload and cur_prompt and "clear intro" not in cur_prompt.lower():
            payload["prompt"] = (
                f"{cur_prompt}, structured progression with clear intro, main theme, buildup, climax, breakdown, and smooth outro"
            )
        elif cur_prompt and "coherent song structure" not in cur_prompt.lower():
            payload["prompt"] = (
                f"{cur_prompt}, coherent song structure, consistent tempo and key throughout, smooth section transitions"
            )

    if is_turbo:
        # Per docs/en/DCW.md, db4 provides smoother low-band extraction than haar on Turbo flow-matching.
        payload.setdefault("dcw_enabled", True)
        payload.setdefault("dcw_mode", "double")
        payload.setdefault("dcw_wavelet", "db4")
        if effective_thinking:
            payload.setdefault("dcw_scaler", 0.02)
            payload.setdefault("dcw_high_scaler", 0.06)
        else:
            payload.setdefault("dcw_scaler", 0.05)
            payload.setdefault("dcw_high_scaler", 0.02)
    elif dur >= 120.0:
        # Per docs/en/INFERENCE.md, non-turbo long outputs improve with ADG + higher steps + shift=3.0.
        target_steps = 56 if dur >= 180.0 else 48
        payload["inference_steps"] = max(int(payload.get("inference_steps") or steps), target_steps)
        payload["use_adg"] = True
        payload["shift"] = 3.0
        payload.setdefault("cfg_interval_start", 0.0)
        payload.setdefault("cfg_interval_end", 0.95)

    if effective_thinking and dur >= 90.0:
        # Guard 5Hz LM against autoregressive audio-code repetition drift past ~450 codes (~90s+).
        min_rep = 1.12 if dur >= 150.0 else 1.08
        payload["lm_repetition_penalty"] = max(float(payload.get("lm_repetition_penalty") or 1.0), min_rep)
        payload.setdefault("lm_temperature", 0.78 if dur >= 150.0 else 0.82)
        payload.setdefault("lm_top_p", 0.88)
        payload.setdefault("lm_cfg_scale", 2.8)


def _plan_chapter_durations(total_duration: float) -> list[float]:
    """Split a >2 min song into <=100s coherent chapters (Ch1 text2music + Ch2..k repaint extensions)."""
    dur = round(max(10.0, float(total_duration)), 1)
    if dur <= _LONG_SINGLE_PASS_LIMIT_SEC:
        return [dur]
    n_chapters = max(2, min(4, math.ceil(dur / 95.0)))
    base_len = math.floor(dur / n_chapters)
    rem = round(dur - base_len * n_chapters, 1)
    chapters = [float(base_len)] * n_chapters
    chapters[0] = round(chapters[0] + rem, 1)
    return chapters


def _partition_lyrics_for_chapters(
    structured_lyrics: str,
    n_chapters: int,
    *,
    is_instrumental: bool = False,
) -> list[str]:
    """Divide structured `[Section]` blocks evenly across chapters, preserving transition cues on continuations."""
    if is_instrumental:
        return ["[Instrumental]"] * max(1, n_chapters)
    if n_chapters <= 1:
        return [structured_lyrics]
    sections = _split_lyric_sections(structured_lyrics)
    if not sections:
        sections = [("[Verse]", "")]

    chorus_fallback = next(
        (sec for sec in sections if any(k in sec[0].lower() for k in ("chorus", "refrão", "theme", "hook"))),
        sections[-1],
    )
    out: list[str] = []
    total = len(sections)
    for idx in range(n_chapters):
        start = round(idx * total / n_chapters)
        end = round((idx + 1) * total / n_chapters)
        chunk = list(sections[start:end])
        if not chunk:
            chunk = [("[Chorus - reprise]", chorus_fallback[1])]
        if idx > 0:
            # 0..18s of the repaint request replays the preserved context tail before new lyrics enter.
            chunk.insert(0, ("[Bridge - seamless continuation]", ""))
        out.append(_render_sections(chunk))
    return out


def _load_preferences() -> dict:
    p = _preferences_path()
    if not p.is_file():
        return {"likes": [], "dislikes": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {
                "likes": list(data.get("likes") or []),
                "dislikes": list(data.get("dislikes") or []),
            }
    except Exception:  # noqa: BLE001
        pass
    return {"likes": [], "dislikes": []}


def _prompt_tokens(text: str) -> set[str]:
    """Extract normalized descriptive tokens for style-similarity matching."""
    stop = {
        "with", "and", "the", "for", "from", "song", "music", "track", "audio",
        "clear", "lead", "vocals", "voice", "singing", "style", "brazilian", "portuguese",
    }
    return {
        tok
        for tok in re.findall(r"[a-zA-Z0-9\u00c0-\u017f]{3,}", (text or "").lower())
        if tok not in stop
    }


def _record_feedback(meta: dict, rating: str, filename: str | None = None) -> dict:
    prefs = _load_preferences()
    dur_val = meta.get("duration") if meta.get("duration") is not None else meta.get("audio_duration")
    entry = {
        "filename": filename or "",
        "prompt": str(meta.get("prompt") or "")[:180],
        "vocal_mode": meta.get("vocal_mode") or "vocal",
        "vocal_gender": meta.get("vocal_gender") or "auto",
        "vocal_language": meta.get("vocal_language") or "pt",
        "model": meta.get("model") or "",
        "guidance_scale": meta.get("guidance_scale"),
        "inference_steps": meta.get("inference_steps"),
        "audio_cover_strength": meta.get("audio_cover_strength"),
        "bpm": meta.get("bpm"),
        "duration": dur_val,
        "exclude_styles": str(meta.get("exclude_styles") or "")[:120],
        "max_mode": bool(meta.get("max_mode", False)),
        "weirdness": meta.get("weirdness"),
        "style_influence": meta.get("style_influence"),
        "variety": meta.get("variety"),
        "studio_mode": meta.get("studio_mode") or "create",
    }
    def _matches(item: dict) -> bool:
        if filename and item.get("filename"):
            return item.get("filename") == filename
        return item.get("prompt") == entry["prompt"]

    prefs["dislikes"] = [d for d in prefs["dislikes"] if not _matches(d)]
    prefs["likes"] = [l for l in prefs["likes"] if not _matches(l)]
    if rating == "dislike":
        prefs["dislikes"] = [entry, *prefs["dislikes"]][:20]
    elif rating == "like":
        prefs["likes"] = [entry, *prefs["likes"]][:20]
    try:
        p = _preferences_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(prefs, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.warning("Failed to save music preferences: %s", exc)
    return prefs


def _apply_learned_preferences(
    prefs: dict,
    *,
    prompt: str,
    vocal_mode: str,
    vocal_gender: str,
    model: str,
    is_turbo: bool,
    is_inst: bool,
    has_src_audio: bool,
    steps: int,
    guidance: float,
    cover_strength: float,
) -> dict:
    """Adapt parameters from past likes/dislikes using style similarity and artifact avoidance."""
    likes = list(prefs.get("likes") or [])
    dislikes = list(prefs.get("dislikes") or [])
    cur_tokens = _prompt_tokens(prompt)
    learned_negative: list[str] = []
    min_rep_penalty = 1.0
    resolved_gender = vocal_gender

    if dislikes:
        similar_dislikes = [
            d
            for d in dislikes
            if (cur_tokens and (_prompt_tokens(d.get("prompt") or "") & cur_tokens))
            or (d.get("vocal_mode") == vocal_mode and d.get("model") == model)
        ]
        if not is_turbo:
            min_steps = 44 if similar_dislikes else 40
            if steps < min_steps:
                steps = min_steps
        boost = 1.2 if similar_dislikes else 1.0
        if guidance < 8.5:
            guidance = round(min(9.5, guidance + boost), 1)
        min_rep_penalty = 1.12 if similar_dislikes else 1.06
        if not is_inst and "vocal-forward mix" not in prompt.lower():
            prompt = f"vocal-forward mix, studio quality, {prompt}"
        if has_src_audio and cover_strength < 0.6:
            cover_strength = 0.6

        low_prompt = prompt.lower()
        base_anti = (
            ("muffled instruments", "muddy mix", "harsh distortion", "tempo drift")
            if is_inst
            else ("muffled vocals", "off-key singing", "muddy mix", "robotic distortion", "tempo drift")
        )
        learned_negative.extend(cue for cue in base_anti if cue not in low_prompt)

    if likes:
        similar_likes = [
            l for l in likes if cur_tokens and (_prompt_tokens(l.get("prompt") or "") & cur_tokens)
        ]
        ref_likes = similar_likes[:5] if similar_likes else likes[:5]
        liked_guidance = [
            float(l["guidance_scale"])
            for l in ref_likes
            if isinstance(l.get("guidance_scale"), (int, float))
        ]
        if liked_guidance and abs(guidance - 7.0) < 0.1:
            avg_g = sum(liked_guidance) / len(liked_guidance)
            guidance = round(max(5.0, min(9.5, avg_g)), 1)

        if not is_inst and resolved_gender == "auto":
            gender_votes = [
                str(l.get("vocal_gender") or "")
                for l in ref_likes
                if l.get("vocal_gender") in {"male", "female"}
            ]
            if len(gender_votes) >= 2:
                male_votes = gender_votes.count("male")
                female_votes = gender_votes.count("female")
                candidate = "male" if male_votes > female_votes else ("female" if female_votes > male_votes else "auto")
                disliked_same = any(d.get("vocal_gender") == candidate for d in dislikes[:5])
                if candidate in {"male", "female"} and not disliked_same:
                    resolved_gender = candidate

    return {
        "prompt": prompt,
        "vocal_gender": resolved_gender,
        "steps": steps,
        "guidance": guidance,
        "cover_strength": cover_strength,
        "learned_negative": learned_negative,
        "min_rep_penalty": min_rep_penalty,
    }


def _summarize_preferences(prefs: dict) -> dict:
    likes = list(prefs.get("likes") or [])
    dislikes = list(prefs.get("dislikes") or [])
    genders = [l.get("vocal_gender") for l in likes if l.get("vocal_gender") in {"male", "female"}]
    preferred_gender = None
    if len(genders) >= 2:
        if genders.count("male") > genders.count("female"):
            preferred_gender = "male"
        elif genders.count("female") > genders.count("male"):
            preferred_gender = "female"
    return {
        "likes_count": len(likes),
        "dislikes_count": len(dislikes),
        "preferred_gender": preferred_gender,
        "avoidance_active": bool(dislikes),
    }


class MusicGenerateRequest(BaseModel):
    title: str | None = Field(default=None, description="Optional user-defined track title.")
    prompt: str = Field(..., min_length=1, description="Style, genre, mood, and instruments description.")
    lyrics: str = Field(default="", description="Song lyrics with optional [Verse], [Chorus], [Bridge] tags.")
    studio_mode: Literal["create", "clone", "add_vocals", "add_inst"] = "create"
    vocal_mode: Literal["vocal", "instrumental"] = "vocal"
    vocal_gender: Literal["auto", "male", "female"] = Field(
        default="auto",
        description="Lead vocal gender preference ('auto', 'male', or 'female').",
    )
    exclude_styles: str = Field(
        default="",
        description="Comma-separated styles, instruments, or timbres to exclude via negative conditioning.",
    )
    duration_mode: Literal["custom", "auto"] = "custom"
    max_mode: bool = False
    weirdness: int = Field(default=50, ge=0, le=100)
    style_influence: int = Field(default=50, ge=0, le=100)
    variety: int = Field(default=50, ge=0, le=100)
    use_personalize: bool = True
    task_type: Literal["text2music", "cover", "repaint"] = "text2music"
    model: str | None = Field(default=None, description="ACE-Step model (e.g. acestep-v15-turbo, acestep-v15-sft).")
    vocal_language: str = Field(default="pt", description="Vocal language code (e.g. pt, en, es, ja, zh).")
    bpm: int | None = Field(default=None, ge=30, le=260)
    audio_duration: float | None = Field(default=30.0, ge=-1.0, le=360.0)
    long_form_coherence: bool = Field(
        default=True,
        description="Split >2 min text2music songs into coherent overlap-repainted chapters to prevent mid-song drift.",
    )
    inference_steps: int = Field(default=8, ge=1, le=100)
    guidance_scale: float = Field(default=7.0, ge=1.0, le=20.0)
    seed: int = Field(default=-1, description="-1 for random seed.")
    src_audio_path: str | None = Field(default=None, description="Optional source audio path for cover/remix.")
    reference_audio_path: str | None = Field(default=None, description="Optional reference audio for style transfer.")
    audio_cover_strength: float = Field(default=0.45, ge=0.0, le=1.0)
    cover_noise_strength: float = Field(default=0.0, ge=0.0, le=1.0)
    repainting_start: float = Field(default=0.0, ge=0.0)
    repainting_end: float | None = Field(default=None, ge=0.0)
    full_analysis_only: bool = False
    audio_format: Literal["mp3", "wav", "flac"] = "mp3"
    thinking: bool = False
    use_format: bool = False
    unload_vram: bool = Field(default=True, description="Unload VoiceStudio TTS models before music generation.")


class SeparateRequest(BaseModel):
    audio_url: str = Field(..., description="VoiceStudio /audio/<filename> URL to separate.")
    mode: Literal["2stems", "4stems", "6stems"] = "2stems"


class StitchRequest(BaseModel):
    base_audio_url: str
    extension_audio_url: str
    continue_at: float = Field(default=30.0, gt=0.0)


class MultitrackItem(BaseModel):
    audio_url: str
    volume: float = Field(default=1.0, ge=0.0, le=2.0)
    pan: float = Field(default=0.0, ge=-1.0, le=1.0)
    pitch_semitones: float = Field(default=0.0, ge=-12.0, le=12.0)
    start_sec: float = Field(default=0.0, ge=0.0, le=300.0)
    mute: bool = False


class MixMultitrackRequest(BaseModel):
    tracks: list[MultitrackItem] = Field(..., min_length=1)


class FormatLyricsRequest(BaseModel):
    prompt: str = Field(default="")
    lyrics: str = Field(default="")
    bpm: int | None = None
    duration: float | None = None
    vocal_language: str = "pt"


class RemasterRequest(BaseModel):
    audio_url: str = Field(..., description="VoiceStudio /audio/<filename> URL to remaster.")


class ResolveOutputRequest(BaseModel):
    audio_url: str = Field(..., description="VoiceStudio /audio/<filename> URL to resolve.")


class AnalyzeMusicRequest(BaseModel):
    src_audio_path: str = Field(..., min_length=1, description="Local path to the uploaded song to analyze.")


class EditAudioRequest(BaseModel):
    audio_url: str = Field(..., description="VoiceStudio /audio/<filename> URL to edit.")
    trim_start: float = Field(default=0.0, ge=0.0)
    trim_end: float | None = Field(default=None, gt=0.0)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    gain_db: float = Field(default=0.0, ge=-24.0, le=24.0)
    fade_in: float = Field(default=0.0, ge=0.0, le=10.0)
    fade_out: float = Field(default=0.0, ge=0.0, le=10.0)


@router.get("/api/music/status")
async def music_status():
    return await music_sidecar.get_status()


@router.get("/api/music/logs")
async def music_logs(lines: int = 80):
    return {"lines": music_sidecar.read_sidecar_logs(max_lines=max(1, min(lines, 300)))}


@router.post("/api/music/sidecar/start")
async def music_sidecar_start():
    try:
        return music_sidecar.start_sidecar()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to start ACE-Step sidecar: {exc}") from exc


@router.post("/api/music/sidecar/stop")
async def music_sidecar_stop():
    return music_sidecar.stop_sidecar()


@router.post("/api/music/upload-source")
async def music_upload_source(file: UploadFile = File(...)):
    """Save a user-uploaded audio file for ACE-Step cover/remix mode."""
    sources_dir = Path(OUTPUTS_DIR) / "music_sources"
    sources_dir.mkdir(parents=True, exist_ok=True)
    raw_ext = (Path(file.filename or "audio.mp3").suffix or ".mp3").lower()
    ext = re.sub(r"[^a-z0-9.]", "", raw_ext)
    if not ext.startswith(".") or len(ext) < 2 or len(ext) > 10:
        ext = ".mp3"
    dest = sources_dir / f"src_{uuid.uuid4().hex[:12]}{ext}"
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")
    dest.write_bytes(content)
    return {
        "path": str(dest),
        "filename": dest.name,
        "audio_url": f"/audio/music_sources/{dest.name}",
    }


def _probe_wav_duration(wav_path: Path, fallback: float = 0.0) -> float:
    try:
        with wave.open(str(wav_path), "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate() or 48000
            return max(0.0, float(frames) / float(rate))
    except Exception:  # noqa: BLE001
        return fallback


async def _submit_and_wait_sidecar_chapter(
    payload: dict,
    work_dir: Path,
    chapter_idx: int,
    n_chapters: int,
    job_state: dict,
) -> Path:
    """Submit a single ACE-Step generation/repaint task, poll until completion, and download WAV."""
    raw = await music_sidecar.release_task(payload)
    task_id = (raw.get("data") or {}).get("task_id")
    if not task_id:
        raise RuntimeError(f"Unexpected ACE-Step response on chapter {chapter_idx + 1}: {raw}")

    loop = asyncio.get_running_loop()
    deadline = loop.time() + 600.0
    while loop.time() < deadline:
        await asyncio.sleep(2.0)
        q_raw = await music_sidecar.query_result(task_id)
        items = q_raw.get("data") or []
        if not items:
            continue
        entry = items[0]
        code = entry.get("status", 0)
        progress_hint = (entry.get("progress_text") or "").strip()
        prefix = f"Parte {chapter_idx + 1}/{n_chapters}"
        job_state["progress_text"] = f"{prefix} · {progress_hint}" if progress_hint else prefix
        if code == 2:
            raw_res = entry.get("result")
            err = entry.get("error") or progress_hint or "Chapter generation failed"
            if not entry.get("error") and isinstance(raw_res, str):
                try:
                    parsed = json.loads(raw_res)
                    if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
                        err = parsed[0].get("error") or err
                except json.JSONDecodeError:
                    pass
            raise RuntimeError(_clean_acestep_error(err) or str(err))
        if code == 1:
            remote_files = _extract_audio_paths(entry.get("result"))
            if not remote_files:
                raise RuntimeError(f"ACE-Step returned no audio for chapter {chapter_idx + 1}.")
            local_wav = await music_sidecar.download_audio_to_outputs(remote_files[0], work_dir)
            return local_wav
    raise RuntimeError(f"Timeout waiting for chapter {chapter_idx + 1}/{n_chapters} to complete.")


async def _build_repaint_context_wav(
    master_wav: Path,
    context_sec: float,
    new_sec: float,
    work_dir: Path,
    chapter_idx: int,
) -> tuple[Path, float]:
    """Slice tail `context_sec` of `master_wav` and append `new_sec` of silence as repaint scaffold."""
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

    master_dur = _probe_wav_duration(master_wav)
    if master_dur <= 1.0:
        raise RuntimeError(f"Generated chapter audio is empty or unreadable ({master_wav.name}).")
    actual_ctx = min(context_sec, max(6.0, master_dur * 0.45))
    tail_start = max(0.0, master_dur - actual_ctx)
    ctx_wav = work_dir / f"ctx_ch{chapter_idx}.wav"
    ffmpeg = find_ffmpeg()
    fc = (
        f"[0:a]atrim=start={tail_start:.3f}:end={master_dur:.3f},asetpts=PTS-STARTPTS,"
        f"aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[tail];"
        f"anullsrc=r=48000:cl=stereo:d={new_sec:.3f}[sil];"
        f"[tail][sil]concat=n=2:v=0:a=1[out]"
    )
    rc, _, err = await run_ffmpeg(
        [ffmpeg, "-y", "-i", str(master_wav), "-filter_complex", fc, "-map", "[out]", "-c:a", "pcm_s16le", str(ctx_wav)],
        timeout=120.0,
    )
    if rc != 0 or not ctx_wav.is_file():
        raise RuntimeError(f"Failed to prepare repaint context for chapter {chapter_idx + 1}: {str(err)[-240:]}")
    return ctx_wav, actual_ctx


async def _stitch_repaint_continuation(
    master_wav: Path,
    repaint_wav: Path,
    context_sec: float,
    out_wav: Path,
) -> None:
    """Seamlessly splice `repaint_wav[context_sec:]` onto `master_wav` across the aligned overlap boundary."""
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

    xfade = 0.20
    cut_sec = max(0.0, context_sec - xfade)
    ffmpeg = find_ffmpeg()
    fc = (
        f"[0:a]aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0];"
        f"[1:a]atrim=start={cut_sec:.3f},aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];"
        f"[a0][a1]acrossfade=d={xfade:.2f}:c1=qsin:c2=qsin[out]"
    )
    rc, _, err = await run_ffmpeg(
        [ffmpeg, "-y", "-i", str(master_wav), "-i", str(repaint_wav), "-filter_complex", fc, "-map", "[out]", "-c:a", "pcm_s16le", str(out_wav)],
        timeout=180.0,
    )
    if rc != 0 or not out_wav.is_file():
        raise RuntimeError(f"Failed to stitch chapter audio: {str(err)[-240:]}")


async def _finalize_master_audio(
    master_wav: Path,
    audio_format: str,
    task_meta: dict,
) -> tuple[str, float | None]:
    """Encode final stitched master WAV into requested output format inside `OUTPUTS_DIR` and write metadata."""
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

    outputs_dir = Path(OUTPUTS_DIR).resolve()
    outputs_dir.mkdir(parents=True, exist_ok=True)
    ext = audio_format if audio_format in {"mp3", "wav", "flac"} else "mp3"
    out_name = f"acestep_long_{uuid.uuid4().hex[:12]}.{ext}"
    dst = outputs_dir / out_name

    if ext == "wav":
        shutil.copy2(master_wav, dst)
    else:
        ffmpeg = find_ffmpeg()
        cmd = [ffmpeg, "-y", "-i", str(master_wav)]
        if ext == "mp3":
            cmd.extend(["-codec:a", "libmp3lame", "-b:a", "320k"])
        else:
            cmd.extend(["-codec:a", "flac"])
        cmd.append(str(dst))
        rc, _, err = await run_ffmpeg(cmd, timeout=180.0)
        if rc != 0 or not dst.is_file():
            raise RuntimeError(f"Failed to encode final {ext} audio: {str(err)[-240:]}")

    probed_dur = await asyncio.to_thread(_probe_audio_duration, dst)
    per_meta = dict(task_meta)
    if probed_dur and probed_dur > 0:
        per_meta["duration"] = probed_dur
    _write_track_meta(dst, per_meta)
    return f"/audio/{out_name}", probed_dur


async def _execute_long_form_job(
    long_id: str,
    *,
    base_payload: dict,
    chapter_durations: list[float],
    chapter_lyrics: list[str],
    is_turbo: bool,
    effective_thinking: bool,
    steps: int,
    target_format: str,
    task_meta: dict,
) -> None:
    """Execute a multi-chapter long song job seamlessly and update `_LONG_TASK_JOBS[long_id]`."""
    job_state = _LONG_TASK_JOBS[long_id]
    n_chapters = len(chapter_durations)
    work_dir = Path(tempfile.mkdtemp(prefix=f"music_long_{long_id[:8]}_"))
    try:
        # Stage 1: Generate opening chapter via lossless WAV so multi-stage splicing has zero recompression loss.
        ch1_dur = chapter_durations[0]
        ch1_payload = dict(base_payload)
        ch1_payload["audio_duration"] = ch1_dur
        ch1_payload["lyrics"] = chapter_lyrics[0]
        ch1_payload["audio_format"] = "wav"
        if n_chapters > 1 and not ch1_payload.get("lyrics", "").strip().lower() in {"[inst]", "[instrumental]"}:
            ch1_payload["prompt"] = f"{base_payload['prompt']}, opening section, establish clear central melody and hook"
        _tune_payload_for_duration(
            ch1_payload,
            duration=ch1_dur,
            is_turbo=is_turbo,
            effective_thinking=effective_thinking,
            steps=steps,
        )

        job_state["progress_text"] = f"Parte 1/{n_chapters} (base musical {int(ch1_dur)}s)..."
        master_wav = await _submit_and_wait_sidecar_chapter(ch1_payload, work_dir, 0, n_chapters, job_state)

        # Stage 2..N: Continue using ACE-Step repaint conditioned on 18s overlap context tail.
        for idx in range(1, n_chapters):
            new_sec = chapter_durations[idx]
            ctx_wav, actual_ctx = await _build_repaint_context_wav(
                master_wav,
                _LONG_CONTEXT_OVERLAP_SEC,
                new_sec,
                work_dir,
                idx,
            )
            ctx_dur = _probe_wav_duration(ctx_wav, fallback=actual_ctx + new_sec)
            is_last = idx == (n_chapters - 1)
            cont_cue = (
                "climax and clean natural ending, seamless continuation of identical tempo, key, and vocal timbre"
                if is_last
                else "seamless continuation maintaining identical tempo, key, groove, and vocal timbre"
            )
            ext_payload = {
                "prompt": f"{cont_cue}, {base_payload['prompt']}",
                "lyrics": chapter_lyrics[idx],
                "task_type": "repaint",
                "src_audio_path": str(ctx_wav),
                "vocal_language": base_payload["vocal_language"],
                "audio_duration": round(ctx_dur, 2),
                "repainting_start": round(actual_ctx, 2),
                "repainting_end": round(ctx_dur, 2),
                "chunk_mask_mode": "explicit",
                "repaint_mode": "balanced",
                "repaint_strength": 0.35,
                "repaint_latent_crossfade_frames": 20,
                "repaint_wav_crossfade_sec": 0.04,
                "inference_steps": steps,
                "guidance_scale": base_payload["guidance_scale"],
                "shift": 3.0 if is_turbo else 1.0,
                "batch_size": 1,
                "audio_format": "wav",
                "thinking": False,
                "use_format": False,
                "use_cot_caption": False,
                "use_cot_language": False,
                "use_random_seed": True,
                "seed": -1,
            }
            if base_payload.get("model"):
                ext_payload["model"] = base_payload["model"]
            if base_payload.get("bpm") is not None:
                ext_payload["bpm"] = base_payload["bpm"]
            if base_payload.get("lm_negative_prompt"):
                ext_payload["lm_negative_prompt"] = base_payload["lm_negative_prompt"]
            if base_payload.get("infer_method"):
                ext_payload["infer_method"] = base_payload["infer_method"]
            if base_payload.get("use_adg"):
                ext_payload["use_adg"] = True
            for dcw_key in ("dcw_enabled", "dcw_mode", "dcw_scaler", "dcw_high_scaler", "dcw_wavelet"):
                if dcw_key in base_payload:
                    ext_payload[dcw_key] = base_payload[dcw_key]
            _tune_payload_for_duration(
                ext_payload,
                duration=ctx_dur,
                is_turbo=is_turbo,
                effective_thinking=False,
                steps=steps,
            )

            job_state["progress_text"] = f"Parte {idx + 1}/{n_chapters} (continuidade +{int(new_sec)}s)..."
            repaint_wav = await _submit_and_wait_sidecar_chapter(ext_payload, work_dir, idx, n_chapters, job_state)

            stitched_wav = work_dir / f"master_after_ch{idx + 1}.wav"
            await _stitch_repaint_continuation(master_wav, repaint_wav, actual_ctx, stitched_wav)
            master_wav = stitched_wav

        job_state["progress_text"] = "Masterizando música completa..."
        final_url, probed_dur = await _finalize_master_audio(master_wav, target_format, task_meta)
        job_state["status"] = "succeeded"
        job_state["audio_urls"] = [final_url]
        job_state["duration"] = probed_dur
        job_state["progress_text"] = "Concluído"
    except Exception as exc:  # noqa: BLE001
        logger.exception("Long-form music job %s failed", long_id)
        job_state["status"] = "failed"
        job_state["error"] = _clean_acestep_error(str(exc)) or str(exc)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@router.post("/api/music/generate")
async def music_generate(req: MusicGenerateRequest):
    healthy, err, health_details = await music_sidecar.check_health_details()
    if not healthy:
        raise HTTPException(
            status_code=503,
            detail=f"ACE-Step 1.5 sidecar is not ready ({err or 'offline'}). Start it first.",
        )

    if req.unload_vram:
        try:
            import services.model_manager as mm
            from services import model_lifecycle

            await model_lifecycle.unload_all()
            mm.free_vram()
        except Exception as exc:  # noqa: BLE001
            logger.debug("VRAM unload before music generation skipped: %s", exc)

    llm_ready = bool(health_details.get("llm_initialized"))
    is_turbo = "turbo" in (req.model or "turbo").lower()
    steps = req.inference_steps
    if not is_turbo and steps == 8:
        steps = 32
    guidance = req.guidance_scale

    prefs = _load_preferences() if req.use_personalize else {"likes": [], "dislikes": []}
    cover_strength = req.audio_cover_strength
    cover_noise = req.cover_noise_strength
    clean_lyrics = (req.lyrics or "").strip()
    is_inst = (
        req.vocal_mode == "instrumental"
        or clean_lyrics.lower() in {"[inst]", "[instrumental]"}
    )
    learned = _apply_learned_preferences(
        prefs,
        prompt=req.prompt.strip(),
        vocal_mode="instrumental" if is_inst else "vocal",
        vocal_gender=req.vocal_gender,
        model=req.model or "acestep-v15-turbo",
        is_turbo=is_turbo,
        is_inst=is_inst,
        has_src_audio=bool(req.src_audio_path),
        steps=steps,
        guidance=guidance,
        cover_strength=cover_strength,
    )
    effective_prompt = learned["prompt"]
    effective_gender = learned["vocal_gender"]
    steps = learned["steps"]
    guidance = learned["guidance"]
    cover_strength = learned["cover_strength"]

    effective_lyrics = req.lyrics
    effective_lang = _detect_vocal_language(req.lyrics, effective_prompt, req.vocal_language or "pt")
    effective_bpm = _infer_smart_bpm(effective_prompt, req.lyrics, req.bpm)
    if req.src_audio_path and req.task_type == "text2music":
        effective_task_type = (
            "repaint"
            if (req.repainting_start > 0.0 or req.repainting_end is not None)
            else "cover"
        )
    else:
        effective_task_type = req.task_type

    if req.src_audio_path and effective_task_type == "cover":
        if req.studio_mode == "add_inst":
            cover_strength = max(cover_strength, 0.72)
            cover_noise = min(cover_noise, 0.15)
            if "preserve existing lead vocals" not in effective_prompt.lower():
                effective_prompt = (
                    f"{effective_prompt}, preserve existing lead vocals cleanly, "
                    "build full band instrumental arrangement, tight drums, warm bassline, harmonic chords"
                )
        elif req.studio_mode == "add_vocals":
            cover_strength = max(cover_strength, 0.70)
            if "over existing instrumental" not in effective_prompt.lower():
                effective_prompt = (
                    f"expressive lead vocals mixed clearly over existing instrumental track, {effective_prompt}"
                )

    # Only pass thinking/CoT when the running ACE-Step sidecar actually has 5Hz LM initialized;
    # otherwise ACE-Step raises `5Hz LM init failed` on every request.
    effective_thinking = bool(
        llm_ready and (req.thinking or req.max_mode or (not is_inst and effective_task_type == "text2music"))
    )
    effective_use_format = bool(req.use_format and llm_ready)

    is_auto_duration = (
        req.duration_mode == "auto"
        or req.audio_duration is None
        or req.audio_duration <= 0
    )
    if is_auto_duration:
        lyrics_auto = _estimate_duration_from_lyrics(clean_lyrics, None, force_auto=True)
        if lyrics_auto is not None:
            effective_duration: float | None = lyrics_auto
        elif effective_thinking:
            effective_duration = -1.0
        else:
            effective_duration = 90.0
    else:
        effective_duration = _estimate_duration_from_lyrics(req.lyrics, req.audio_duration)

    if is_inst:
        effective_lyrics = _plan_song_structure_for_duration("", effective_duration, is_instrumental=True)
        if "instrumental" not in effective_prompt.lower():
            effective_prompt = f"{effective_prompt}, purely instrumental, no vocals, no singing"
    else:
        # Remove conflicting instrumental-only tags when vocal singing is requested,
        # while preserving arrangement/backing phrases such as `build full band instrumental arrangement`.
        effective_prompt = _strip_instrumental_only_clauses(effective_prompt, fallback=req.prompt)
        effective_prompt = _apply_vocal_gender_prompt(
            effective_prompt,
            effective_gender,
            is_instrumental=False,
        )
        lower_p = effective_prompt.lower()
        if effective_lang == "pt" and "portugu" not in lower_p and "brazil" not in lower_p:
            effective_prompt = f"Brazilian Portuguese singing vocals, {effective_prompt}"
        if not any(tok in lower_p for tok in ("vocal", "vocals", "sing", "voice", "voz", "cant")):
            effective_prompt = f"clear lead vocals, expressive singing voice, {effective_prompt}"
        effective_lyrics = _plan_song_structure_for_duration(clean_lyrics, effective_duration, is_instrumental=False)

    payload: dict = {
        "prompt": effective_prompt,
        "lyrics": effective_lyrics,
        "task_type": effective_task_type,
        "vocal_language": effective_lang,
        "audio_duration": effective_duration,
        "inference_steps": steps,
        "guidance_scale": guidance,
        "shift": 3.0 if is_turbo else 1.0,
        "batch_size": 1,
        "audio_format": req.audio_format,
        "thinking": effective_thinking,
        "use_format": effective_use_format,
        "use_cot_caption": effective_thinking,
        "use_cot_language": effective_thinking,
        "use_random_seed": req.seed < 0,
        "seed": req.seed,
    }
    if learned["learned_negative"]:
        payload["lm_negative_prompt"] = ", ".join(learned["learned_negative"])
    if effective_thinking and learned["min_rep_penalty"] > 1.0:
        payload["lm_repetition_penalty"] = learned["min_rep_penalty"]
    if req.model:
        payload["model"] = req.model
    if effective_bpm is not None:
        payload["bpm"] = effective_bpm
    if req.src_audio_path:
        payload["src_audio_path"] = req.src_audio_path
        payload["audio_cover_strength"] = cover_strength
        payload["cover_noise_strength"] = cover_noise
        payload["repainting_start"] = req.repainting_start
        if req.repainting_end is not None:
            payload["repainting_end"] = req.repainting_end
        if effective_task_type == "repaint":
            payload["chunk_mask_mode"] = "explicit"
    if req.reference_audio_path:
        payload["reference_audio_path"] = req.reference_audio_path
    if req.full_analysis_only:
        payload["full_analysis_only"] = True

    task_meta = {
        "title": (req.title or "").strip() or None,
        "prompt": req.prompt.strip(),
        "lyrics": "" if is_inst else effective_lyrics,
        "studio_mode": req.studio_mode,
        "vocal_mode": "instrumental" if is_inst else "vocal",
        "vocal_gender": effective_gender,
        "exclude_styles": req.exclude_styles.strip(),
        "duration_mode": req.duration_mode,
        "max_mode": req.max_mode,
        "weirdness": req.weirdness,
        "style_influence": req.style_influence,
        "variety": req.variety,
        "model": req.model or "acestep-v15-turbo",
        "vocal_language": effective_lang,
        "bpm": effective_bpm,
        "duration": effective_duration,
        "inference_steps": steps,
        "guidance_scale": guidance,
        "seed": req.seed,
        "format": req.audio_format,
        "listened": False,
    }

    dur_val = float(effective_duration if effective_duration and effective_duration > 0 else 30.0)
    use_multi_chapter = (
        (req.long_form_coherence or req.max_mode)
        and effective_task_type == "text2music"
        and not req.src_audio_path
        and not req.full_analysis_only
        and dur_val > _LONG_SINGLE_PASS_LIMIT_SEC
    )
    if use_multi_chapter:
        _tune_payload_for_duration(
            payload,
            duration=dur_val,
            is_turbo=is_turbo,
            effective_thinking=effective_thinking,
            steps=steps,
        )
        _apply_advanced_controls(
            payload,
            is_turbo=is_turbo,
            effective_thinking=effective_thinking,
            exclude_styles=req.exclude_styles,
            max_mode=req.max_mode,
            weirdness=req.weirdness,
            style_influence=req.style_influence,
            variety=req.variety,
            has_src_audio=False,
        )
        chapter_durs = _plan_chapter_durations(dur_val)
        chapter_lyrics = _partition_lyrics_for_chapters(
            effective_lyrics,
            len(chapter_durs),
            is_instrumental=is_inst,
        )
        long_id = f"long_{uuid.uuid4().hex[:16]}"
        _store_bounded(
            _LONG_TASK_JOBS,
            long_id,
            {
                "status": "running",
                "progress_text": f"Parte 1/{len(chapter_durs)} (base musical {int(chapter_durs[0])}s)...",
                "audio_urls": [],
                "error": None,
            },
        )
        asyncio.create_task(
            _execute_long_form_job(
                long_id,
                base_payload=payload,
                chapter_durations=chapter_durs,
                chapter_lyrics=chapter_lyrics,
                is_turbo=is_turbo,
                effective_thinking=effective_thinking,
                steps=steps,
                target_format=req.audio_format,
                task_meta=task_meta,
            )
        )
        return {"task_id": long_id, "queue_position": 0, "chapters": len(chapter_durs)}

    _tune_payload_for_duration(
        payload,
        duration=effective_duration,
        is_turbo=is_turbo,
        effective_thinking=effective_thinking,
        steps=steps,
    )
    _apply_advanced_controls(
        payload,
        is_turbo=is_turbo,
        effective_thinking=effective_thinking,
        exclude_styles=req.exclude_styles,
        max_mode=req.max_mode,
        weirdness=req.weirdness,
        style_influence=req.style_influence,
        variety=req.variety,
        has_src_audio=bool(req.src_audio_path),
    )

    try:
        raw = await music_sidecar.release_task(payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"ACE-Step /release_task failed: {exc}") from exc

    data = raw.get("data") or {}
    task_id = data.get("task_id")
    if not task_id:
        raise HTTPException(status_code=502, detail=f"Unexpected ACE-Step response: {raw}")

    _store_bounded(_TASK_META, task_id, task_meta)
    return {"task_id": task_id, "queue_position": data.get("queue_position")}


def _extract_audio_paths(result_field: object) -> list[str]:
    """Parse ACE-Step's `result` field (list or JSON string) into file paths."""
    parsed = result_field
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except json.JSONDecodeError:
            return []
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        return []
    paths: list[str] = []
    for item in parsed:
        if isinstance(item, str) and item.strip():
            paths.append(item.strip())
        elif isinstance(item, dict):
            if isinstance(item.get("audio_paths"), list):
                paths.extend(str(p) for p in item["audio_paths"] if p)
            val = item.get("file") or item.get("audio_path") or item.get("path") or item.get("url")
            if val:
                paths.append(str(val))
    return paths


def _normalize_analysis_item(item: dict) -> dict:
    metas = item.get("metas") if isinstance(item.get("metas"), dict) else item
    lyrics = str(metas.get("lyrics") or item.get("lyrics") or "").strip()
    if lyrics.lower() in {"[inst]", "[instrumental]"}:
        lyrics = ""
    prompt = str(metas.get("caption") or metas.get("prompt") or item.get("prompt") or "").strip()
    return {
        "prompt": prompt,
        "lyrics": lyrics,
        "bpm": metas.get("bpm") or item.get("bpm"),
        "duration": metas.get("duration") or item.get("duration"),
        "vocal_language": str(metas.get("vocal_language") or metas.get("language") or "").strip(),
    }


def _extract_analysis(result_field: object) -> dict | None:
    """Extract caption/lyrics/metas from ACE-Step full_analysis_only results."""
    parsed = result_field
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except json.JSONDecodeError:
            return None
    if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
        return _normalize_analysis_item(parsed[0])
    if isinstance(parsed, dict):
        return _normalize_analysis_item(parsed)
    return None


def _clean_acestep_error(raw_err: str | None) -> str:
    msg = (raw_err or "").strip()
    if not msg:
        return "ACE-Step falhou ao processar a tarefa."
    if "| INFO | [initialize_service]" in msg or "Keeping main model on" in msg:
        return (
            "ACE-Step falhou na execução após carregar o modelo na GPU "
            "(5Hz LM indisponível ou erro ao processar o áudio/parâmetros)."
        )
    return msg


def _estimate_bpm_from_onset(onset: "np.ndarray", frame_rate_hz: float) -> int | None:
    """Estimate BPM using unbiased onset autocorrelation with octave-error disambiguation."""
    import numpy as np

    if len(onset) < 200 or frame_rate_hz <= 0 or float(np.std(onset)) <= 1e-6:
        return None
    centered = onset - np.mean(onset)
    raw_ac = np.correlate(centered, centered, mode="full")[len(centered) - 1 :]
    overlap = np.arange(len(centered), 0, -1, dtype=np.float64)
    ac = np.maximum(0.0, raw_ac / np.maximum(1.0, overlap))

    min_lag = max(1, int(round(60.0 / 185.0 * frame_rate_hz)))
    max_lag = min(len(ac) // 2, int(round(60.0 / 58.0 * frame_rate_hz)))
    if max_lag <= min_lag:
        return None

    # Gentle perceptual tempo prior around ~118 BPM (Ellis 2007 log-normal weighting)
    # resolves half/double-time ambiguities without suppressing true ballads or fast tracks.
    lags = np.arange(min_lag, max_lag + 1, dtype=np.float64)
    bpms = 60.0 * frame_rate_hz / lags
    prior = np.exp(-0.5 * (np.log2(bpms / 118.0) / 0.65) ** 2)
    scores = ac[min_lag : max_lag + 1] * prior

    best_lag = int(lags[int(np.argmax(scores))])
    return int(round(60.0 * frame_rate_hz / best_lag)) if best_lag > 0 else None


def _analyze_audio_acoustics_sync(audio_path: str) -> dict:
    """Measure exact duration, estimate BPM with octave disambiguation, and profile spectral balance."""
    result: dict = {
        "duration": None,
        "bpm": None,
        "vocal_presence": "unknown",
        "warm_bass": False,
        "bright_highs": False,
        "energy": "medium",
        "suggested_instrumental": False,
    }
    try:
        import numpy as np
        import soundfile as sf

        data, sr = sf.read(audio_path, always_2d=True)
        if data.size == 0 or sr <= 0:
            return result
        dur = round(float(data.shape[0] / sr), 1)
        result["duration"] = dur
        mono = data.mean(axis=1).astype(np.float32)
        max_samples = min(len(mono), int(sr * 60))
        mono = mono[:max_samples]
        hop = max(1, int(sr * 0.01))
        n_frames = len(mono) // hop
        if n_frames > 300:
            frames = mono[: n_frames * hop].reshape(n_frames, hop)
            env = np.sqrt(np.mean(frames * frames, axis=1))
            onset = np.maximum(0.0, np.diff(env))
            result["bpm"] = _estimate_bpm_from_onset(onset, float(sr) / hop)

        # Spectral vocal band (300Hz-3400Hz), bass (<160Hz), and air/brightness (4kHz-12kHz)
        seg = mono[: min(len(mono), int(sr * 20))]
        if len(seg) > 2048:
            spec = np.abs(np.fft.rfft(seg))
            freqs = np.fft.rfftfreq(len(seg), d=1.0 / sr)
            vocal_e = float(np.sum(spec[(freqs >= 300) & (freqs <= 3400)] ** 2))
            bass_e = float(np.sum(spec[(freqs >= 30) & (freqs <= 160)] ** 2))
            high_e = float(np.sum(spec[(freqs >= 4000) & (freqs <= 12000)] ** 2))
            total_e = float(np.sum(spec ** 2)) + 1e-9
            vocal_ratio = vocal_e / total_e
            bass_ratio = bass_e / total_e
            high_ratio = high_e / total_e
            rms_energy = float(np.sqrt(np.mean(seg * seg)))

            if vocal_ratio > 0.45 and bass_ratio < 0.08:
                result["vocal_presence"] = "vocal_heavy"
            elif vocal_ratio > 0.25:
                result["vocal_presence"] = "full_mix"
            else:
                result["vocal_presence"] = "instrumental_heavy"
                result["suggested_instrumental"] = True

            result["warm_bass"] = bass_ratio > 0.22
            result["bright_highs"] = high_ratio > 0.14
            result["energy"] = "high" if rms_energy > 0.18 else ("low" if rms_energy < 0.055 else "medium")
    except Exception:  # noqa: BLE001
        pass
    return result


async def _ensure_readable_wav(audio_path: str) -> tuple[str, bool]:
    """Return a soundfile-readable path (transcoding M4A/AAC/MP4/WEBM to temp WAV when needed)."""
    try:
        import soundfile as sf

        await asyncio.to_thread(sf.info, audio_path)
        return audio_path, False
    except Exception:
        pass
    try:
        from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

        ffmpeg = find_ffmpeg()
        if ffmpeg:
            fd, tmp_wav = tempfile.mkstemp(prefix="music_analyze_", suffix=".wav")
            os.close(fd)
            rc, _, _ = await run_ffmpeg(
                [ffmpeg, "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmp_wav],
                timeout=60.0,
            )
            if rc == 0 and Path(tmp_wav).is_file() and Path(tmp_wav).stat().st_size > 0:
                return tmp_wav, True
            Path(tmp_wav).unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass
    return audio_path, False


def _transcribe_cached_faster_whisper_sync(wav_path: str) -> str | None:
    """Scan only already-downloaded local HF/CTranslate2 Whisper snapshots (zero network calls) and transcribe."""
    try:
        from faster_whisper import WhisperModel
        from huggingface_hub import scan_cache_dir

        cache_info = scan_cache_dir()
        whisper_dirs: list[str] = []
        for repo in cache_info.repos:
            if "whisper" in repo.repo_id.lower() and repo.revisions:
                latest = sorted(repo.revisions, key=lambda r: r.last_modified, reverse=True)[0]
                if (latest.snapshot_path / "model.bin").is_file():
                    whisper_dirs.append(str(latest.snapshot_path))
        if not whisper_dirs:
            return None
        model = WhisperModel(whisper_dirs[0], device="cpu", compute_type="int8", local_files_only=True)
        try:
            segments, _ = model.transcribe(wav_path, vad_filter=True)
            text = " ".join(s.text.strip() for s in segments if s.text and s.text.strip()).strip()
            return text or None
        finally:
            del model
    except Exception as exc:  # noqa: BLE001
        logger.debug("Direct cached faster-whisper scan failed: %s", exc)
        return None


async def _extract_base_audio_features(audio_path: str) -> tuple[str | None, dict]:
    """Transcode if needed, run acoustic analysis, and transcribe speech/vocals locally."""
    readable_path, is_tmp = await _ensure_readable_wav(audio_path)
    try:
        acoustics = await asyncio.to_thread(_analyze_audio_acoustics_sync, readable_path)
        cleaned: str | None = None
        try:
            from services.asr_backend import reference_asr_installed, transcribe_reference

            if await asyncio.to_thread(reference_asr_installed):
                text = await asyncio.to_thread(transcribe_reference, readable_path, release_after=True)
                cleaned = (text or "").strip() or None
        except Exception as exc:  # noqa: BLE001
            logger.debug("asr_backend fallback failed: %s", exc)

        if not cleaned:
            cleaned = await asyncio.to_thread(_transcribe_cached_faster_whisper_sync, readable_path)

        return cleaned, acoustics
    finally:
        if is_tmp:
            Path(readable_path).unlink(missing_ok=True)


async def _transcribe_base_audio_fallback(audio_path: str) -> tuple[str | None, float | None, int | None, str]:
    """Use VoiceStudio's installed local ASR model + acoustic analysis when ACE-Step misses lyrics/BPM."""
    cleaned, acoustics = await _extract_base_audio_features(audio_path)
    return (
        cleaned,
        acoustics.get("duration"),
        acoustics.get("bpm"),
        acoustics.get("vocal_presence", "unknown"),
    )


async def _run_local_base_audio_analysis(audio_path: str, reason: str | None = None) -> dict:
    """Analyze base audio completely locally using acoustics + local Whisper without depending on ACE-Step LM."""
    asr_text, acoustics = await _extract_base_audio_features(audio_path)
    dur = acoustics.get("duration")
    est_bpm = acoustics.get("bpm")
    presence = acoustics.get("vocal_presence", "unknown")
    if dur is None and asr_text is None:
        return {
            "status": "failed",
            "audio_urls": [],
            "analysis": None,
            "error": _clean_acestep_error(reason) or "Não foi possível decodificar o arquivo de áudio base.",
        }

    detected_lang = _detect_vocal_language(asr_text or "", "", "pt") if asr_text else "pt"
    descriptors: list[str] = []
    if presence == "vocal_heavy":
        descriptors.append(
            "Brazilian Portuguese lead vocals, full band instrumental arrangement"
            if detected_lang == "pt"
            else "expressive lead vocals, full band instrumental arrangement"
        )
    elif presence == "instrumental_heavy":
        descriptors.append("rich instrumental production, melodic arrangement")
    else:
        descriptors.append(
            "Brazilian Portuguese singing vocals, expressive full arrangement"
            if detected_lang == "pt"
            else "expressive singing vocals, full musical arrangement"
        )

    tempo_desc = "upbeat groove" if (est_bpm or 120) >= 120 else ("midtempo melody" if (est_bpm or 120) >= 92 else "slow ballad")
    descriptors.append(tempo_desc)
    if acoustics.get("warm_bass"):
        descriptors.append("warm deep bass")
    if acoustics.get("bright_highs"):
        descriptors.append("crisp bright highs")
    if acoustics.get("energy") == "high":
        descriptors.append("energetic punchy mix")
    elif acoustics.get("energy") == "low":
        descriptors.append("intimate soft dynamics")

    analysis: dict = {
        "prompt": ", ".join(descriptors),
        "lyrics": asr_text or "",
        "bpm": est_bpm,
        "duration": dur,
        "vocal_language": detected_lang,
        "vocal_presence": presence,
        "energy": acoustics.get("energy", "medium"),
        "suggested_instrumental": bool(acoustics.get("suggested_instrumental") and not asr_text),
        "source": "whisper_local" if asr_text else "acoustic_only",
    }
    if not asr_text:
        analysis["lyrics_warning"] = (
            "Duração e ritmo medidos no áudio base, mas nenhum modelo Whisper local transcreveu a letra "
            "(verifique em Configurações ou digite a letra manualmente)."
        )
    elif reason:
        analysis["warning"] = _clean_acestep_error(reason)
    return {
        "status": "succeeded",
        "audio_urls": [],
        "analysis": analysis,
        "error": None,
    }


@router.get("/api/music/tasks/{task_id}")
async def music_task_status(task_id: str):
    if task_id in _LOCAL_ANALYZE_RESULTS:
        local_res = _LOCAL_ANALYZE_RESULTS.pop(task_id)
        return {"task_id": task_id, **local_res}

    if task_id in _LONG_TASK_JOBS:
        job = _LONG_TASK_JOBS[task_id]
        snapshot = {
            "task_id": task_id,
            "status": job.get("status", "running"),
            "progress_text": job.get("progress_text"),
            "audio_urls": list(job.get("audio_urls") or []),
            "duration": job.get("duration"),
            "analysis": None,
            "error": job.get("error"),
        }
        if snapshot["status"] in {"succeeded", "failed"}:
            _LONG_TASK_JOBS.pop(task_id, None)
        return snapshot

    try:
        raw = await music_sidecar.query_result(task_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"ACE-Step /query_result failed: {exc}") from exc

    items = raw.get("data") or []
    if not items:
        return {"task_id": task_id, "status": "pending", "audio_urls": [], "analysis": None}

    entry = items[0]
    code = entry.get("status", 0)
    status_map = {0: "running", 1: "succeeded", 2: "failed"}
    status = status_map.get(code, "running")
    audio_urls: list[str] = []
    analysis: dict | None = None
    download_errors: list[str] = []
    error_msg = entry.get("error")
    if not error_msg and status == "failed":
        raw_res = entry.get("result")
        if isinstance(raw_res, str):
            try:
                raw_res = json.loads(raw_res)
            except json.JSONDecodeError:
                raw_res = None
        if isinstance(raw_res, list) and raw_res and isinstance(raw_res[0], dict):
            error_msg = raw_res[0].get("error") or entry.get("progress_text")
        elif isinstance(raw_res, dict):
            error_msg = raw_res.get("error") or entry.get("progress_text")
        else:
            error_msg = entry.get("progress_text")

    if status == "succeeded":
        remote_files = _extract_audio_paths(entry.get("result"))
        outputs_dir = Path(OUTPUTS_DIR)
        task_meta = _TASK_META.pop(task_id, None)
        resolved_duration: float | None = None
        for remote_path in remote_files:
            try:
                local_path = await music_sidecar.download_audio_to_outputs(remote_path, outputs_dir)
                probed = await asyncio.to_thread(_probe_audio_duration, local_path)
                if resolved_duration is None and probed and probed > 0:
                    resolved_duration = probed
                if task_meta:
                    per_file_meta = dict(task_meta)
                    raw_dur = per_file_meta.get("duration")
                    if raw_dur is None or (isinstance(raw_dur, (int, float)) and raw_dur <= 0):
                        if probed and probed > 0:
                            per_file_meta["duration"] = probed
                        else:
                            per_file_meta.pop("duration", None)
                    elif resolved_duration is None and isinstance(raw_dur, (int, float)) and raw_dur > 0:
                        resolved_duration = float(raw_dur)
                    _write_track_meta(local_path, per_file_meta)
                audio_urls.append(f"/audio/{local_path.name}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to fetch ACE-Step audio %s: %s", remote_path, exc)
                download_errors.append(str(exc))
        if not audio_urls:
            analysis = _extract_analysis(entry.get("result"))
            analyze_src = _ANALYZE_META.pop(task_id, None)
            if analyze_src:
                has_lyrics = bool(analysis and (analysis.get("lyrics") or "").strip())
                if not has_lyrics:
                    asr_text, probed_dur, est_bpm, presence = await _transcribe_base_audio_fallback(analyze_src)
                    if analysis is None:
                        analysis = {"prompt": "", "lyrics": "", "bpm": None, "duration": None, "vocal_language": ""}
                    if asr_text:
                        analysis["lyrics"] = asr_text
                        analysis["vocal_language"] = _detect_vocal_language(asr_text, analysis.get("prompt") or "", "pt")
                        if not analysis.get("prompt"):
                            analysis["prompt"] = "Brazilian Portuguese vocals, expressive singing" if analysis["vocal_language"] == "pt" else "expressive lead vocals"
                        analysis["source"] = "acestep+whisper" if analysis.get("prompt") else "whisper_fallback"
                    elif analysis.get("prompt"):
                        analysis["source"] = "acestep"
                        analysis["lyrics_warning"] = "Estilo lido, mas nenhuma fala/letra clara foi detectada no áudio."
                    else:
                        local_res = await _run_local_base_audio_analysis(analyze_src)
                        return {"task_id": task_id, **local_res}
                    if not analysis.get("duration") and probed_dur:
                        analysis["duration"] = probed_dur
                    if not analysis.get("bpm") and est_bpm:
                        analysis["bpm"] = est_bpm
                    analysis["vocal_presence"] = presence
                    analysis["suggested_instrumental"] = presence == "instrumental_heavy"
                else:
                    analysis["source"] = "acestep"
            elif remote_files and not analysis:
                status = "failed"
                error_msg = (
                    f"ACE-Step generated {len(remote_files)} file(s), but download failed: "
                    + ("; ".join(download_errors) or "unknown error")
                )
    elif status == "failed":
        analyze_src = _ANALYZE_META.pop(task_id, None)
        if analyze_src:
            local_res = await _run_local_base_audio_analysis(analyze_src, reason=error_msg)
            return {"task_id": task_id, **local_res}
        error_msg = _clean_acestep_error(error_msg)

    progress_text = (entry.get("progress_text") or "").strip() or None
    return {
        "task_id": task_id,
        "status": status,
        "audio_urls": audio_urls,
        "duration": resolved_duration if status == "succeeded" else None,
        "analysis": analysis,
        "progress_text": progress_text,
        "error": error_msg,
    }


@router.post("/api/music/separate")
async def music_separate_stems(req: SeparateRequest):
    """Separate stems (2-stems or 4-stems) from a music track using VoiceStudio's Demucs."""
    filename = Path(req.audio_url.split("?")[0]).name
    outputs_dir = Path(OUTPUTS_DIR).resolve()
    input_path = (outputs_dir / filename).resolve()
    if not input_path.is_file() or outputs_dir not in input_path.parents:
        raise HTTPException(status_code=404, detail="Audio file not found in outputs directory.")

    try:
        stems = await asyncio.to_thread(
            music_sidecar.separate_stems_sync, input_path, outputs_dir, req.mode
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Stem separation failed: {exc}") from exc

    return {
        "vocals_url": f"/audio/{stems['vocals'].name}",
        "vocals_path": str(stems["vocals"]),
        "instrumental_url": f"/audio/{stems['instrumental'].name}" if "instrumental" in stems else None,
        "drums_url": f"/audio/{stems['drums'].name}" if "drums" in stems else None,
        "bass_url": f"/audio/{stems['bass'].name}" if "bass" in stems else None,
        "guitar_url": f"/audio/{stems['guitar'].name}" if "guitar" in stems else None,
        "piano_url": f"/audio/{stems['piano'].name}" if "piano" in stems else None,
        "other_url": f"/audio/{stems['other'].name}" if "other" in stems else None,
    }


@router.post("/api/music/format-lyrics")
async def music_format_lyrics(req: FormatLyricsRequest):
    """Enhance or generate structured lyrics and style metadata via ACE-Step /format_input."""
    healthy, err = await music_sidecar.check_health()
    if not healthy:
        raise HTTPException(
            status_code=503,
            detail=f"ACE-Step 1.5 sidecar is not ready ({err or 'offline'}). Start it first.",
        )
    import httpx

    param_obj: dict = {}
    if req.bpm is not None:
        param_obj["bpm"] = req.bpm
    if req.duration is not None:
        param_obj["duration"] = int(req.duration)
    param_obj["language"] = _detect_vocal_language(req.lyrics, req.prompt, req.vocal_language or "pt")

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0)) as client:
            resp = await client.post(
                f"{music_sidecar.DEFAULT_ACESTEP_URL}/format_input",
                json={"prompt": req.prompt, "lyrics": req.lyrics, "param_obj": param_obj},
            )
            if resp.status_code >= 400:
                raise RuntimeError(_clean_acestep_error(resp.text[:400]))
            payload = resp.json()
            if payload.get("error"):
                raise RuntimeError(_clean_acestep_error(str(payload["error"])))
            data = payload.get("data") or {}
            if req.duration and req.duration >= 100 and isinstance(data.get("lyrics"), str) and data["lyrics"].strip():
                is_inst_fmt = data["lyrics"].strip().lower() in {"[inst]", "[instrumental]"}
                data["lyrics"] = _plan_song_structure_for_duration(
                    data["lyrics"],
                    req.duration,
                    is_instrumental=is_inst_fmt,
                )
            return data
    except Exception as exc:  # noqa: BLE001
        cleaned_err = _clean_acestep_error(str(exc)) if str(exc) else type(exc).__name__
        raise HTTPException(status_code=502, detail=f"ACE-Step /format_input failed: {cleaned_err}") from exc


@router.post("/api/music/remaster")
async def music_remaster_track(req: RemasterRequest):
    """Apply a clean -14 LUFS mastering chain (EQ + gentle compression + loudnorm) via FFmpeg."""
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

    filename = Path(req.audio_url.split("?")[0]).name
    outputs_dir = Path(OUTPUTS_DIR).resolve()
    src = (outputs_dir / filename).resolve()
    if not src.is_file() or outputs_dir not in src.parents:
        raise HTTPException(status_code=404, detail="Audio file not found in outputs directory.")

    ext = src.suffix or ".mp3"
    out_name = f"music_master_{uuid.uuid4().hex[:10]}{ext}"
    dst = outputs_dir / out_name
    af = (
        "highpass=f=30,"
        "acompressor=threshold=-16dB:ratio=2.5:attack=10:release=120,"
        "equalizer=f=110:width_type=o:width=1.0:g=1.5,"
        "equalizer=f=8500:width_type=o:width=1.5:g=1.5,"
        "loudnorm=I=-14:TP=-1.0:LRA=11"
    )
    ffmpeg = find_ffmpeg()
    rc, _, err = await run_ffmpeg([ffmpeg, "-y", "-i", str(src), "-af", af, str(dst)], timeout=180.0)
    if rc != 0 or not dst.is_file():
        raise HTTPException(status_code=500, detail=f"Remaster failed: {str(err)[-300:]}")
    probed_dur = await asyncio.to_thread(_probe_audio_duration, dst)
    _inherit_track_meta(src, dst, probed_dur)
    return {"audio_url": f"/audio/{out_name}", "filename": out_name, "duration": probed_dur}


def _resolve_output_file(audio_url: str) -> Path:
    filename = Path(audio_url.split("?")[0]).name
    outputs_dir = Path(OUTPUTS_DIR).resolve()
    target = (outputs_dir / filename).resolve()
    if not target.is_file() or outputs_dir not in target.parents:
        raise HTTPException(status_code=404, detail=f"Audio file not found: {filename}")
    return target


@router.post("/api/music/stitch")
async def music_stitch_extend(req: StitchRequest):
    """Trim base_audio at continue_at and crossfade-concat extension_audio."""
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

    base_path = _resolve_output_file(req.base_audio_url)
    ext_path = _resolve_output_file(req.extension_audio_url)
    out_name = f"music_extended_{uuid.uuid4().hex[:10]}.mp3"
    dst = Path(OUTPUTS_DIR).resolve() / out_name
    ffmpeg = find_ffmpeg()
    fc = (
        f"[0:a]atrim=0:{req.continue_at:.3f},asetpts=PTS-STARTPTS[a0];"
        f"[1:a]asetpts=PTS-STARTPTS[a1];"
        f"[a0][a1]acrossfade=d=0.08:c1=qsin:c2=qsin[out]"
    )
    rc, _, err = await run_ffmpeg(
        [ffmpeg, "-y", "-i", str(base_path), "-i", str(ext_path), "-filter_complex", fc, "-map", "[out]", str(dst)],
        timeout=180.0,
    )
    if rc != 0 or not dst.is_file():
        raise HTTPException(status_code=500, detail=f"Stitch failed: {str(err)[-300:]}")
    probed_dur = await asyncio.to_thread(_probe_audio_duration, dst)
    _inherit_track_meta(base_path, dst, probed_dur)
    return {"audio_url": f"/audio/{out_name}", "filename": out_name, "duration": probed_dur}


def _build_multitrack_filter(idx: int, item: MultitrackItem) -> tuple[str, str]:
    """Build normalized 48 kHz stereo FFmpeg filter chain and label for a multitrack mixer stem."""
    filters: list[str] = [
        "aformat=sample_rates=48000:channel_layouts=stereo",
        f"volume={item.volume:.3f}",
    ]
    if abs(item.pitch_semitones) > 0.01:
        ratio = 2.0 ** (item.pitch_semitones / 12.0)
        filters.append(f"asetrate=48000*{ratio:.6f},aresample=48000,atempo={1.0 / ratio:.6f}")
    left_gain = min(1.0, 1.0 - item.pan)
    right_gain = min(1.0, 1.0 + item.pan)
    filters.append(f"pan=stereo|c0={left_gain:.3f}*c0|c1={right_gain:.3f}*c1")
    if item.start_sec > 0.01:
        delay_ms = int(round(item.start_sec * 1000))
        filters.append(f"adelay={delay_ms}|{delay_ms}")
    lbl = f"t{idx}"
    return f"[{idx}:a]{','.join(filters)}[{lbl}]", f"[{lbl}]"


@router.post("/api/music/mix-multitrack")
async def music_mix_multitrack(req: MixMultitrackRequest):
    """Mix multiple tracks/stems with per-track volume, stereo pan, and pitch shift."""
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

    active = [t for t in req.tracks if not t.mute]
    if not active:
        raise HTTPException(status_code=400, detail="At least one unmuted track is required.")

    inputs: list[str] = []
    chains: list[str] = []
    labels: list[str] = []
    for idx, item in enumerate(active):
        path = _resolve_output_file(item.audio_url)
        inputs += ["-i", str(path)]
        chain, lbl = _build_multitrack_filter(idx, item)
        chains.append(chain)
        labels.append(lbl)

    chains.append(f"{''.join(labels)}amix=inputs={len(active)}:duration=longest:normalize=0[out]")
    out_name = f"music_mix_{uuid.uuid4().hex[:10]}.mp3"
    dst = Path(OUTPUTS_DIR).resolve() / out_name
    ffmpeg = find_ffmpeg()
    rc, _, err = await run_ffmpeg(
        [ffmpeg, "-y", *inputs, "-filter_complex", ";".join(chains), "-map", "[out]", str(dst)],
        timeout=240.0,
    )
    if rc != 0 or not dst.is_file():
        raise HTTPException(status_code=500, detail=f"Multitrack mix failed: {str(err)[-300:]}")
    probed_dur = await asyncio.to_thread(_probe_audio_duration, dst)
    _write_track_meta(
        dst,
        {
            "title": f"Multitrack Mix ({len(active)} faixas)",
            "prompt": f"Multitrack Mix ({len(active)} faixas)",
            "duration": probed_dur,
            "format": "mp3",
            "listened": False,
        },
    )
    return {"audio_url": f"/audio/{out_name}", "filename": out_name, "duration": probed_dur}


@router.post("/api/music/random-sample")
async def music_random_sample():
    """Fetch a random musical prompt/lyrics sample from ACE-Step 1.5."""
    healthy, err = await music_sidecar.check_health()
    if not healthy:
        raise HTTPException(
            status_code=503,
            detail=f"ACE-Step 1.5 sidecar is not ready ({err or 'offline'}). Start it first.",
        )
    import httpx

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            resp = await client.post(
                f"{music_sidecar.DEFAULT_ACESTEP_URL}/create_random_sample",
                json={"sample_type": "custom_mode"},
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:400]}")
            return resp.json().get("data") or {}
    except Exception as exc:  # noqa: BLE001
        detail_msg = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        raise HTTPException(
            status_code=502,
            detail=f"ACE-Step /create_random_sample failed: {detail_msg}",
        ) from exc


@router.post("/api/music/analyze")
async def music_analyze_song(req: AnalyzeMusicRequest):
    """Read an uploaded song to extract style, lyrics, duration, and BPM."""
    src_file = Path(req.src_audio_path)
    if not src_file.is_file():
        raise HTTPException(status_code=400, detail="Arquivo de áudio base não encontrado no disco.")
    healthy, _, details = await music_sidecar.check_health_details()
    llm_ready = bool(healthy and details.get("llm_initialized"))

    if llm_ready:
        try:
            raw = await music_sidecar.release_task(
                {
                    "src_audio_path": req.src_audio_path,
                    "task_type": "cover",
                    "full_analysis_only": True,
                    "thinking": True,
                    "prompt": "analyze song",
                }
            )
            data = raw.get("data") or {}
            task_id = data.get("task_id")
            if task_id:
                _store_bounded(_ANALYZE_META, task_id, req.src_audio_path)
                return {"task_id": task_id}
        except Exception as exc:  # noqa: BLE001
            logger.debug("ACE-Step analyze unavailable (%s); falling back to local analyzer.", exc)

    # Sidecar 5Hz LM not initialized or unavailable: run EliVoice's local acoustic + Whisper analyzer directly
    local_id = f"local_{uuid.uuid4().hex[:12]}"
    local_res = await _run_local_base_audio_analysis(req.src_audio_path)
    _store_bounded(_LOCAL_ANALYZE_RESULTS, local_id, local_res)
    return {"task_id": local_id}


@router.post("/api/music/resolve-output")
async def music_resolve_output(req: ResolveOutputRequest):
    """Resolve a VoiceStudio /audio/<filename> URL to its local path for Cover/Remix."""
    filename = Path(req.audio_url.split("?")[0]).name
    outputs_dir = Path(OUTPUTS_DIR).resolve()
    target = (outputs_dir / filename).resolve()
    if not target.is_file() or outputs_dir not in target.parents:
        raise HTTPException(status_code=404, detail="Audio file not found in outputs directory.")
    return {"path": str(target), "filename": target.name}


@router.post("/api/music/edit-audio")
async def music_edit_audio(req: EditAudioRequest):
    """Trim, adjust speed/gain, and apply fade-in/out using VoiceStudio's FFmpeg."""
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

    filename = Path(req.audio_url.split("?")[0]).name
    outputs_dir = Path(OUTPUTS_DIR).resolve()
    src = (outputs_dir / filename).resolve()
    if not src.is_file() or outputs_dir not in src.parents:
        raise HTTPException(status_code=404, detail="Audio file not found in outputs directory.")

    ext = src.suffix or ".mp3"
    out_name = f"music_edit_{uuid.uuid4().hex[:10]}{ext}"
    dst = outputs_dir / out_name

    filters: list[str] = []
    if req.trim_start > 0 or req.trim_end is not None:
        end_part = f":end={req.trim_end}" if req.trim_end is not None else ""
        filters.append(f"atrim=start={req.trim_start}{end_part},asetpts=PTS-STARTPTS")
    if abs(req.speed - 1.0) > 1e-3:
        filters.append(f"atempo={req.speed:.3f}")
    if abs(req.gain_db) > 1e-2:
        filters.append(f"volume={req.gain_db:.1f}dB")
    if req.fade_in > 0:
        filters.append(f"afade=t=in:st=0:d={req.fade_in:.2f}")
    if req.fade_out > 0:
        # Reverse-fade avoids needing exact duration when trim/atempo changed length
        filters.append(f"areverse,afade=t=in:st=0:d={req.fade_out:.2f},areverse")

    ffmpeg = find_ffmpeg()
    cmd = [ffmpeg, "-y", "-i", str(src)]
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd.append(str(dst))

    rc, _, err = await run_ffmpeg(cmd, timeout=180.0)
    if rc != 0 or not dst.is_file():
        raise HTTPException(status_code=500, detail=f"FFmpeg edit failed: {str(err)[-300:]}")

    probed_dur = await asyncio.to_thread(_probe_audio_duration, dst)
    _inherit_track_meta(src, dst, probed_dur)
    return {"audio_url": f"/audio/{out_name}", "filename": out_name, "duration": probed_dur}


_MUSIC_PREFIXES = ("music_", "acestep_long_", "remaster_", "mix_", "stitched_")
_RAW_STEM_PREFIXES = (
    "music_vocals_",
    "music_instrumental_",
    "music_drums_",
    "music_bass_",
    "music_guitar_",
    "music_piano_",
    "music_other_",
)
_AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}


def _list_music_library_sync(outputs_dir: Path, limit: int = 40) -> list[dict]:
    """Scan OUTPUTS_DIR synchronously for persisted generated music tracks, newest first."""
    if not outputs_dir.is_dir():
        return []

    items: list[tuple[float, dict]] = []
    for path in outputs_dir.iterdir():
        if not path.is_file():
            continue
        if path.suffix.lower() not in _AUDIO_EXTS:
            continue
        if not path.name.startswith(_MUSIC_PREFIXES):
            continue
        if path.name.startswith(_RAW_STEM_PREFIXES) and not _meta_path_for(path).is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        meta = _read_track_meta(path)
        items.append(
            (
                stat.st_mtime,
                {
                    "id": f"disk-{path.stem}",
                    "url": f"/audio/{path.name}",
                    "filename": path.name,
                    "format": path.suffix.lstrip(".").lower() or "mp3",
                    "size_bytes": stat.st_size,
                    "created_at": stat.st_mtime,
                    **meta,
                },
            )
        )

    items.sort(key=lambda pair: pair[0], reverse=True)
    return [entry for _, entry in items[: max(1, min(limit, 100))]]


@router.get("/api/music/library")
async def music_library(limit: int = 40):
    """List persisted generated music files from OUTPUTS_DIR, newest first."""
    tracks = await asyncio.to_thread(_list_music_library_sync, Path(OUTPUTS_DIR), limit)
    return {"tracks": tracks}


class TrackMetadataUpdate(BaseModel):
    title: str | None = None
    prompt: str | None = None
    lyrics: str | None = None
    bpm: int | None = Field(default=None, ge=30, le=260)
    vocal_language: str | None = None
    vocal_mode: Literal["vocal", "instrumental"] | None = None
    rating: Literal["like", "dislike", "none"] | None = None
    listened: bool | None = None


@router.patch("/api/music/tracks/{filename}")
async def music_update_track_metadata(filename: str, req: TrackMetadataUpdate):
    """Update persisted metadata (title, prompt, lyrics, bpm, vocal_mode, rating) for a track."""
    safe_name = Path(filename).name
    outputs_dir = Path(OUTPUTS_DIR).resolve()
    target = (outputs_dir / safe_name).resolve()
    if not target.is_file() or target.parent != outputs_dir:
        raise HTTPException(status_code=404, detail="Audio track not found.")
    updates = req.model_dump(exclude_unset=True)
    meta = _write_track_meta(target, updates)
    if req.rating in ("like", "dislike", "none"):
        _record_feedback(meta, req.rating, filename=safe_name)
    return {"updated": True, "filename": safe_name, "metadata": meta}


@router.get("/api/music/preferences")
async def music_get_preferences():
    """Return learned like/dislike preference counts for adaptive generation."""
    return _summarize_preferences(_load_preferences())


@router.delete("/api/music/preferences")
async def music_clear_preferences():
    """Reset learned like/dislike preference memory."""
    p = _preferences_path()
    if p.is_file():
        p.unlink(missing_ok=True)
    return {"cleared": True}


class TrashMoveRequest(BaseModel):
    audio_url: str


def _trash_dir() -> Path:
    d = Path(OUTPUTS_DIR).resolve() / ".trash"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get("/api/music/trash")
async def music_trash_list():
    """List trashed music files stored in OUTPUTS_DIR/.trash."""
    tdir = _trash_dir()
    items: list[tuple[float, dict]] = []
    for path in tdir.iterdir():
        if not path.is_file() or path.suffix.lower() not in _AUDIO_EXTS:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        meta = _read_track_meta(path)
        items.append(
            (
                stat.st_mtime,
                {
                    "id": f"trash-{path.stem}",
                    "url": f"/audio/.trash/{path.name}",
                    "filename": path.name,
                    "format": path.suffix.lstrip(".").lower() or "mp3",
                    "size_bytes": stat.st_size,
                    "created_at": stat.st_mtime,
                    **meta,
                },
            )
        )
    items.sort(key=lambda pair: pair[0], reverse=True)
    return {"tracks": [entry for _, entry in items]}


@router.post("/api/music/trash/move")
async def music_trash_move(req: TrashMoveRequest):
    """Move a generated music file (and its .meta.json) from OUTPUTS_DIR into OUTPUTS_DIR/.trash."""
    filename = Path(req.audio_url.split("?")[0]).name
    outputs_dir = Path(OUTPUTS_DIR).resolve()
    src = (outputs_dir / filename).resolve()
    if src.is_file() and src.parent == outputs_dir:
        tdir = _trash_dir()
        dst = tdir / filename
        src.replace(dst)
        src_meta = _meta_path_for(src)
        if src_meta.is_file():
            src_meta.replace(_meta_path_for(dst))
        return {"trashed": True, "filename": filename, "trash_url": f"/audio/.trash/{filename}"}
    return {"trashed": False, "filename": filename}


@router.post("/api/music/trash/restore")
async def music_trash_restore(req: TrashMoveRequest):
    """Restore a trashed music file (and its .meta.json) back into OUTPUTS_DIR."""
    filename = Path(req.audio_url.split("?")[0]).name
    tdir = _trash_dir()
    src = (tdir / filename).resolve()
    if not src.is_file() or src.parent != tdir:
        raise HTTPException(status_code=404, detail="Trashed audio file not found.")
    dst = Path(OUTPUTS_DIR).resolve() / filename
    src.replace(dst)
    src_meta = _meta_path_for(src)
    if src_meta.is_file():
        src_meta.replace(_meta_path_for(dst))
    meta = _read_track_meta(dst)
    return {"restored": True, "filename": filename, "audio_url": f"/audio/{filename}", "metadata": meta}


@router.delete("/api/music/trash/{filename}")
async def music_trash_delete_one(filename: str):
    """Permanently delete a single trashed audio file and its metadata."""
    safe_name = Path(filename).name
    tdir = _trash_dir()
    target = (tdir / safe_name).resolve()
    if not target.is_file() or target.parent != tdir:
        raise HTTPException(status_code=404, detail="Trashed audio file not found.")
    target.unlink(missing_ok=True)
    _meta_path_for(target).unlink(missing_ok=True)
    return {"deleted": True, "filename": safe_name}


@router.delete("/api/music/trash")
async def music_trash_empty():
    """Permanently delete all audio and metadata files in OUTPUTS_DIR/.trash."""
    tdir = _trash_dir()
    removed = 0
    for path in list(tdir.iterdir()):
        if path.is_file():
            try:
                is_audio = path.suffix.lower() in _AUDIO_EXTS
                path.unlink()
                if is_audio:
                    removed += 1
            except OSError:
                pass
    return {"emptied": True, "removed": removed}
