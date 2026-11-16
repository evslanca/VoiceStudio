import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LayersIcon,
  Loader2Icon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiPath } from '@/lib/api/client';
import { computeProgressPct, formatSeconds } from './job-progress';

export interface MixerTrack {
  id: string;
  label: string;
  audio_url: string;
  volume: number;
  pan: number;
  pitch_semitones: number;
  start_sec: number;
  mute: boolean;
}

interface LiveNode {
  audio: HTMLAudioElement;
  gain: GainNode;
  panner: StereoPannerNode;
  timer?: number;
}

function applyPitchPlaybackRate(audio: HTMLAudioElement, pitchSemitones: number): void {
  const pitchAudio = audio as HTMLAudioElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  pitchAudio.preservesPitch = false;
  pitchAudio.webkitPreservesPitch = false;
  audio.playbackRate = 2 ** (pitchSemitones / 12);
}

function fmtSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function MultitrackMixer({
  tracks,
  mixing,
  opElapsed = 0,
  onUpdateTrack,
  onRemoveTrack,
  onClear,
  onMix,
}: {
  tracks: MixerTrack[];
  mixing: boolean;
  opElapsed?: number;
  onUpdateTrack: (id: string, patch: Partial<MixerTrack>) => void;
  onRemoveTrack: (id: string) => void;
  onClear: () => void;
  onMix: () => void;
}) {
  const { t } = useTranslation();
  const [previewing, setPreviewing] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [totalDur, setTotalDur] = useState(30);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<Map<string, LiveNode>>(new Map());
  const clockRef = useRef<number>(0);

  const stopPreview = () => {
    window.clearInterval(clockRef.current);
    nodesRef.current.forEach(({ audio, timer }) => {
      if (timer) window.clearTimeout(timer);
      audio.pause();
      audio.currentTime = 0;
    });
    nodesRef.current.clear();
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      void ctxRef.current.close().catch(() => {});
    }
    ctxRef.current = null;
    setPreviewing(false);
    setPlayhead(0);
  };

  useEffect(() => () => stopPreview(), []);

  useEffect(() => {
    if (!previewing) return;
    tracks.forEach((tr) => {
      const node = nodesRef.current.get(tr.id);
      if (!node) return;
      node.gain.gain.value = tr.mute ? 0 : tr.volume;
      node.panner.pan.value = tr.pan;
      applyPitchPlaybackRate(node.audio, tr.pitch_semitones);
    });
  }, [tracks, previewing]);

  const startPreview = async () => {
    stopPreview();
    if (tracks.length === 0) return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    ctxRef.current = ctx;

    const loadedDurs = new Map<string, number>();
    const startedAt = performance.now();

    tracks.forEach((tr) => {
      const audio = new Audio(apiPath(tr.audio_url));
      audio.crossOrigin = 'anonymous';
      applyPitchPlaybackRate(audio, tr.pitch_semitones);
      audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audio.duration)) {
          loadedDurs.set(tr.id, audio.duration);
          setDurations((prev) => ({ ...prev, [tr.id]: audio.duration }));
          const computed = tracks.reduce(
            (mx, item) => Math.max(mx, (loadedDurs.get(item.id) ?? 0) + item.start_sec),
            5,
          );
          setTotalDur(computed);
        }
      });
      const src = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      gain.gain.value = tr.mute ? 0 : tr.volume;
      panner.pan.value = tr.pan;
      src.connect(gain).connect(panner).connect(ctx.destination);
      const entry: LiveNode = { audio, gain, panner };
      if (tr.start_sec > 0.05) {
        entry.timer = window.setTimeout(() => {
          entry.timer = undefined;
          void audio.play().catch(() => {});
        }, tr.start_sec * 1000);
      }
      nodesRef.current.set(tr.id, entry);
    });

    if (ctx.state === 'suspended') await ctx.resume();
    setPreviewing(true);
    clockRef.current = window.setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      setPlayhead(elapsed);
      const allEnded = Array.from(nodesRef.current.values()).every(
        ({ audio, timer }) => !timer && (audio.ended || audio.paused),
      );
      if (elapsed > 0.5 && allEnded) stopPreview();
    }, 200);

    await Promise.all(
      tracks
        .filter((tr) => tr.start_sec <= 0.05)
        .map(({ id }) => nodesRef.current.get(id)?.audio.play().catch(() => {})),
    );
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LayersIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">
            {t('music.mixer_title')} {tracks.length > 0 ? `(${tracks.length})` : ''}
          </h2>
          {previewing && (
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] text-emerald-400">
              {fmtSec(playhead)} / {fmtSec(totalDur)}
            </span>
          )}
        </div>
        {tracks.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => (previewing ? stopPreview() : void startPreview())}
            >
              {previewing ? (
                <>
                  <SquareIcon className="mr-1.5 size-3.5" />
                  Stop
                </>
              ) : (
                <>
                  <PlayIcon className="mr-1.5 size-3.5" />
                  Preview
                </>
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                stopPreview();
                onClear();
              }}
            >
              <Trash2Icon className="mr-1.5 size-3.5" />
              {t('music.clear_history')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="relative overflow-hidden"
              disabled={mixing}
              onClick={onMix}
            >
              {mixing ? (
                <>
                  <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                  {t('music.mixing')} {formatSeconds(opElapsed)}
                  <span
                    className="absolute bottom-0 left-0 h-0.5 bg-primary-foreground/70 transition-all duration-300"
                    style={{ width: `${computeProgressPct(opElapsed, 10)}%` }}
                  />
                </>
              ) : (
                t('music.mix_export')
              )}
            </Button>
          </div>
        )}
      </div>

      {tracks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('music.mixer_empty')}</p>
      ) : (
        <div className="space-y-3">
          {tracks.map((tr) => {
            const clipDur = durations[tr.id] ?? 30;
            const timelineDur = tracks.reduce(
              (mx, item) => Math.max(mx, item.start_sec + (durations[item.id] ?? 30)),
              totalDur,
            );
            const leftPct = Math.min(95, (tr.start_sec / Math.max(1, timelineDur)) * 100);
            const widthPct = Math.max(5, Math.min(100 - leftPct, (clipDur / Math.max(1, timelineDur)) * 100));
            const playheadPct = Math.min(100, (playhead / Math.max(1, timelineDur)) * 100);
            return (
              <div
                key={tr.id}
                className="space-y-2 rounded-lg border border-border/50 bg-background/50 p-3"
              >
                <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1.2fr)_1fr_1fr_1fr_0.9fr_auto]">
              <div className="flex min-w-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="icon-sm"
                  variant={tr.mute ? 'destructive' : 'outline'}
                  onClick={() => onUpdateTrack(tr.id, { mute: !tr.mute })}
                  title="Mute"
                >
                  {tr.mute ? (
                    <VolumeXIcon className="size-3.5" />
                  ) : (
                    <Volume2Icon className="size-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant={
                    !tr.mute && tracks.every((o) => o.id === tr.id || o.mute) ? 'default' : 'outline'
                  }
                  onClick={() => {
                    const isAlreadySolo =
                      !tr.mute && tracks.every((o) => o.id === tr.id || o.mute);
                    tracks.forEach((o) =>
                      onUpdateTrack(o.id, { mute: isAlreadySolo ? false : o.id !== tr.id }),
                    );
                  }}
                  title="Solo"
                  className="text-[11px] font-bold"
                >
                  S
                </Button>
                <span className="truncate text-xs font-medium">{tr.label}</span>
              </div>

              <label className="space-y-1 text-[11px] text-muted-foreground">
                <span className="flex justify-between">
                  <span>Vol</span>
                  <span>{Math.round(tr.volume * 100)}%</span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={tr.volume}
                  onChange={(e) => onUpdateTrack(tr.id, { volume: Number(e.target.value) })}
                  className="w-full"
                />
              </label>

              <label className="space-y-1 text-[11px] text-muted-foreground">
                <span className="flex justify-between">
                  <span>Pan</span>
                  <span>
                    {tr.pan === 0
                      ? 'C'
                      : tr.pan < 0
                        ? `L${Math.round(Math.abs(tr.pan) * 100)}`
                        : `R${Math.round(tr.pan * 100)}`}
                  </span>
                </span>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.1"
                  value={tr.pan}
                  onChange={(e) => onUpdateTrack(tr.id, { pan: Number(e.target.value) })}
                  className="w-full"
                />
              </label>

              <label className="space-y-1 text-[11px] text-muted-foreground">
                <span className="flex justify-between">
                  <span>Pitch</span>
                  <span>
                    {tr.pitch_semitones > 0 ? `+${tr.pitch_semitones}` : tr.pitch_semitones} st
                  </span>
                </span>
                <input
                  type="range"
                  min="-6"
                  max="6"
                  step="1"
                  value={tr.pitch_semitones}
                  onChange={(e) =>
                    onUpdateTrack(tr.id, { pitch_semitones: Number(e.target.value) })
                  }
                  className="w-full"
                />
              </label>

              <label className="space-y-1 text-[11px] text-muted-foreground">
                <span className="flex justify-between">
                  <span>Offset</span>
                  <span>+{tr.start_sec}s</span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="60"
                  step="0.5"
                  value={tr.start_sec}
                  onChange={(e) => onUpdateTrack(tr.id, { start_sec: Number(e.target.value) })}
                  className="w-full"
                />
              </label>

              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  title="Reset"
                  onClick={() =>
                    onUpdateTrack(tr.id, {
                      volume: 1.0,
                      pan: 0.0,
                      pitch_semitones: 0,
                      start_sec: 0,
                      mute: false,
                    })
                  }
                >
                  <RotateCcwIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => onRemoveTrack(tr.id)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>

                {/* Visual timeline clip bar */}
                <div className="relative h-2.5 w-full overflow-hidden rounded bg-muted/40">
                  <div
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    className={`absolute inset-y-0 rounded transition-all ${
                      tr.mute ? 'bg-zinc-500/40' : 'bg-primary/60'
                    }`}
                  />
                  {previewing && (
                    <div
                      style={{ left: `${playheadPct}%` }}
                      className="absolute inset-y-0 w-0.5 bg-emerald-400"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
