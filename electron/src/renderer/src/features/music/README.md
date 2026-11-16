# Music Studio Frontend (`features/music/`)

Dedicated React feature module for the **ACE-Step 1.5** hybrid integration inside VoiceStudio.

## Files
- `music-page.tsx` — Main workspace rendered at route `/music` (sidecar controls, text-to-music, song cloning/analysis, AI lyrics enhancer, style presets).
- `track-card.tsx` — Modular generated-track card with Regenerate, Remix, Extend (`+30s` + auto-stitch), Remaster (`-14 LUFS`), FFmpeg Audio Editor, Demucs 2/4/6-Stem Splitter, Save Persona, and 1-click Voice Profile creation (`POST /profiles`).
- `multitrack-mixer.tsx` — Multitrack DAW-style mixer for stems/tracks (Volume, Stereo Pan, Pitch semitones, Mute, Solo, and FFmpeg mixdown).
- `mini-vu-meter.tsx` — Compact 8-bar Web Audio API LED VU meter observing the card's active `<audio>` element.
