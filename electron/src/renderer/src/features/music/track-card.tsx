import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowRightCircleIcon,
  BookmarkPlusIcon,
  CopyIcon,
  Disc3Icon,
  FileTextIcon,
  LayersIcon,
  Loader2Icon,
  MoreVerticalIcon,
  PencilIcon,
  RefreshCwIcon,
  RepeatIcon,
  ScissorsIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Trash2Icon,
  UserPlusIcon,
  Wand2Icon,
} from 'lucide-react';
import { WaveformPlayer } from '@/components/waveform-player';
import { SaveAudioButton } from '@/components/save-audio-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiPath } from '@/lib/api/client';
import { formatSeconds } from './job-progress';
import { MiniVuMeter } from './mini-vu-meter';

export interface StemResult {
  vocals_url: string;
  vocals_path: string;
  instrumental_url?: string | null;
  drums_url?: string | null;
  bass_url?: string | null;
  guitar_url?: string | null;
  piano_url?: string | null;
  other_url?: string | null;
}

export interface GeneratedTrack {
  id: string;
  url: string;
  title?: string | null;
  prompt: string;
  lyrics?: string;
  bpm?: number | null;
  duration?: number | null;
  vocalLanguage?: string;
  vocalMode?: 'vocal' | 'instrumental';
  vocalGender?: 'auto' | 'male' | 'female';
  excludeStyles?: string;
  durationMode?: 'custom' | 'auto';
  maxMode?: boolean;
  weirdness?: number;
  styleInfluence?: number;
  variety?: number;
  model?: string;
  inferenceSteps?: number | null;
  guidanceScale?: number | null;
  seed?: number | null;
  rating?: 'like' | 'dislike' | null;
  listened?: boolean;
  format: string;
  stems?: StemResult;
}

export interface TrackMetadataPatch {
  title?: string;
  prompt?: string;
  lyrics?: string;
  bpm?: number | null;
  vocal_mode?: 'vocal' | 'instrumental';
}

export interface EditAudioParams {
  audio_url: string;
  trim_start: number;
  trim_end: number | null;
  speed: number;
  gain_db: number;
  fade_in: number;
  fade_out: number;
}

export function TrackCard({
  track,
  separating,
  separatingMode,
  opElapsed = 0,
  creatingProfile,
  editing,
  remastering,
  sidecarHealthy,
  isLatest = false,
  onDelete,
  onRegenerate,
  onRemix,
  onExtend,
  onRemaster,
  onSavePersona,
  onSendToMixer,
  onUseAsCover,
  onRepaintSection,
  onSeparateStems,
  onCreateVoiceProfile,
  onApplyEdit,
  onRate,
  onUpdateMetadata,
  onMarkListened,
  onCloneTrack,
  onOpenInStudio,
}: {
  track: GeneratedTrack;
  separating: boolean;
  separatingMode?: '2stems' | '4stems' | '6stems' | null;
  opElapsed?: number;
  creatingProfile: boolean;
  editing: boolean;
  remastering: boolean;
  sidecarHealthy: boolean;
  isLatest?: boolean;
  onDelete: () => void;
  onRegenerate: () => void;
  onRemix: () => void;
  onExtend: () => void;
  onRemaster: () => void;
  onSavePersona: () => void;
  onSendToMixer: (label: string, url: string) => void;
  onUseAsCover: () => void;
  onRepaintSection: (startSec: number, endSec: number | null) => void;
  onSeparateStems: (mode: '2stems' | '4stems' | '6stems') => void;
  onCreateVoiceProfile: () => void;
  onApplyEdit: (params: EditAudioParams) => void;
  onRate: (rating: 'like' | 'dislike' | 'none') => void;
  onUpdateMetadata: (patch: TrackMetadataPatch) => Promise<void>;
  onMarkListened: () => void;
  onCloneTrack: () => void;
  onOpenInStudio: () => void;
}) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [metaEditOpen, setMetaEditOpen] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [draftTitle, setDraftTitle] = useState(track.title ?? '');
  const [draftPrompt, setDraftPrompt] = useState(track.prompt ?? '');
  const [draftLyrics, setDraftLyrics] = useState(track.lyrics ?? '');
  const [draftBpm, setDraftBpm] = useState(track.bpm ? String(track.bpm) : '');
  const [draftVocalMode, setDraftVocalMode] = useState<'vocal' | 'instrumental'>(
    track.vocalMode ?? 'vocal',
  );
  const [trimStart, setTrimStart] = useState('0');
  const [trimEnd, setTrimEnd] = useState('');
  const [speed, setSpeed] = useState('1.0');
  const [gainDb, setGainDb] = useState('0');
  const [fadeSec, setFadeSec] = useState('0');

  useEffect(() => {
    setDraftTitle(track.title ?? '');
    setDraftPrompt(track.prompt ?? '');
    setDraftLyrics(track.lyrics ?? '');
    setDraftBpm(track.bpm ? String(track.bpm) : '');
    setDraftVocalMode(track.vocalMode ?? 'vocal');
  }, [track.title, track.prompt, track.lyrics, track.bpm, track.vocalMode]);

  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const busyStatusText = remastering
    ? `${t('music.remastering')} ${formatSeconds(opElapsed)}`
    : separating
      ? `${t('music.separating')} ${formatSeconds(opElapsed)}`
      : editing
        ? `${t('music.editing')} ${formatSeconds(opElapsed)}`
        : creatingProfile
          ? `${t('music.creating_profile')} ${formatSeconds(opElapsed)}`
          : null;

  const menuItemClass =
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-foreground whitespace-nowrap transition-colors hover:bg-primary/10 hover:text-primary disabled:pointer-events-none disabled:opacity-50';

  return (
    <div
      ref={cardRef}
      className={`space-y-3 rounded-xl border p-4 transition-colors ${
        isLatest
          ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/25'
          : 'border-border/50 bg-background/60 hover:border-border/90 hover:bg-card/70'
      }`}
    >
      {/* Suno-style Title + Quick Actions Row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-gradient-to-br from-primary/25 via-primary/10 to-muted text-primary shadow-sm">
            <Disc3Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {track.listened === false && (
              <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-foreground">
                {t('music.badge_new')}
              </span>
            )}
            <button
              type="button"
              onClick={() => setMetaEditOpen((v) => !v)}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary"
              title={t('music.edit_metadata')}
              aria-label={t('music.edit_metadata')}
            >
              <PencilIcon className="size-3.5" />
            </button>
            <h3
              className="truncate text-sm font-semibold text-foreground"
              title={track.title || track.prompt}
            >
              {track.title || track.prompt || track.id}
            </h3>
            {track.model && (
              <span className="shrink-0 rounded-md border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-rose-400">
                {track.model.replace('acestep-', '')}
              </span>
            )}
            <span
              className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${
                track.vocalMode === 'instrumental'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              }`}
            >
              {track.vocalMode === 'instrumental'
                ? t('music.vocal_mode_instrumental')
                : t('music.vocal_mode_singing')}
            </span>
            {busyStatusText && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                <Loader2Icon className="size-3 animate-spin" />
                {busyStatusText}
              </span>
            )}
          </div>

          {track.title && track.prompt && (
            <div className="flex items-center gap-1.5">
              <p className="truncate text-xs text-muted-foreground" title={track.prompt}>
                {track.prompt}
              </p>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(track.prompt);
                  toast.success(t('music.prompt_copied'));
                }}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t('music.copy_prompt')}
                aria-label={t('music.copy_prompt')}
              >
                <CopyIcon className="size-3" />
              </button>
            </div>
          )}

          {/* Structured Post-Creation Metadata Pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/80">
              {track.format || 'mp3'}
            </span>
            {track.bpm && (
              <span className="rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {track.bpm} BPM
              </span>
            )}
            {track.duration && (
              <span className="rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {track.duration}s
              </span>
            )}
            {track.vocalLanguage && (
              <span className="rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                {track.vocalLanguage}
              </span>
            )}
            {track.vocalMode !== 'instrumental' && track.vocalGender && track.vocalGender !== 'auto' && (
              <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {track.vocalGender === 'male' ? t('music.gender_male') : t('music.gender_female')}
              </span>
            )}
            {track.maxMode && (
              <span className="rounded-md border border-primary/30 bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                Max
              </span>
            )}
            {track.inferenceSteps && (
              <span className="rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {track.inferenceSteps} steps
              </span>
            )}
            {track.guidanceScale && (
              <span className="rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                CFG {track.guidanceScale}
              </span>
            )}
            {track.seed !== undefined && track.seed !== null && track.seed >= 0 && (
              <span className="rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                #{track.seed}
              </span>
            )}
          </div>
          </div>
        </div>

        {/* Suno-style Right Action Bar: Remix | ThumbsUp | ThumbsDown | Export | 3-Dots */}
        <div className="flex shrink-0 items-center gap-1.5">
          <MiniVuMeter containerRef={cardRef} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 rounded-full px-3 text-xs font-medium"
            onClick={onRemix}
            title={t('music.remix')}
          >
            <SparklesIcon className="mr-1.5 size-3.5" />
            {t('music.remix')}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant={track.rating === 'like' ? 'default' : 'outline'}
            className={`rounded-full ${
              track.rating === 'like'
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'hover:text-emerald-400'
            }`}
            onClick={() => onRate(track.rating === 'like' ? 'none' : 'like')}
            title={t('music.like_track')}
            aria-label={t('music.like_track')}
          >
            <ThumbsUpIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant={track.rating === 'dislike' ? 'destructive' : 'outline'}
            className="rounded-full"
            onClick={() => onRate(track.rating === 'dislike' ? 'none' : 'dislike')}
            title={t('music.dislike_track')}
            aria-label={t('music.dislike_track')}
          >
            <ThumbsDownIcon className="size-3.5" />
          </Button>
          <SaveAudioButton
            url={apiPath(track.url)}
            suggestedName={`${(track.title || track.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.${track.format || 'mp3'}`}
          />

          {/* 3-Dots Action Menu */}
          <div ref={menuRef} className="relative">
            <Button
              type="button"
              size="icon-sm"
              variant={menuOpen ? 'secondary' : 'outline'}
              onClick={() => setMenuOpen((v) => !v)}
              title={t('music.menu_more')}
              aria-label={t('music.menu_more')}
            >
              <MoreVerticalIcon className="size-4" />
            </Button>

            {menuOpen && (
              <div className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-xl border border-border/80 bg-popover p-1.5 shadow-xl">
                <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('music.menu_basic')}
                </div>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenInStudio();
                  }}
                >
                  <SlidersHorizontalIcon className="size-4 shrink-0 text-primary" />
                  <span className="truncate">{t('music.open_in_studio')}</span>
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onCloneTrack();
                  }}
                >
                  <CopyIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.clone_track')}</span>
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    setMetaEditOpen((v) => !v);
                  }}
                >
                  <PencilIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.edit_metadata')}</span>
                </button>
                <button
                  type="button"
                  disabled={!sidecarHealthy}
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onRegenerate();
                  }}
                >
                  <RefreshCwIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.regenerate')}</span>
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onRemix();
                  }}
                >
                  <SparklesIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.remix')}</span>
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onExtend();
                  }}
                >
                  <ArrowRightCircleIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.extend_track')}</span>
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    setEditOpen((v) => !v);
                  }}
                >
                  <SlidersHorizontalIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.edit_track')}</span>
                </button>
                {track.lyrics && (
                  <button
                    type="button"
                    className={menuItemClass}
                    onClick={() => {
                      setMenuOpen(false);
                      setLyricsOpen((v) => !v);
                    }}
                  >
                    <FileTextIcon className="size-4 shrink-0" />
                    <span className="truncate">{t('music.view_lyrics')}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onSendToMixer(track.title || track.prompt.slice(0, 28) || track.id, track.url);
                  }}
                >
                  <LayersIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.send_to_mixer')}</span>
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onSavePersona();
                  }}
                >
                  <BookmarkPlusIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.save_persona')}</span>
                </button>

                <div className="my-1 border-t border-border/50" />
                <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('music.menu_advanced')}
                </div>
                <button
                  type="button"
                  disabled={remastering}
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onRemaster();
                  }}
                >
                  {remastering ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin" />
                  ) : (
                    <Wand2Icon className="size-4 shrink-0" />
                  )}
                  <span className="truncate">
                    {remastering
                      ? `${t('music.remastering')} ${formatSeconds(opElapsed)}`
                      : t('music.remaster')}
                  </span>
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onUseAsCover();
                  }}
                >
                  <RepeatIcon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.use_as_cover')}</span>
                </button>
                <button
                  type="button"
                  disabled={separating}
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onSeparateStems('2stems');
                  }}
                >
                  {separating && (!separatingMode || separatingMode === '2stems') ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin" />
                  ) : (
                    <ScissorsIcon className="size-4 shrink-0" />
                  )}
                  <span className="truncate">
                    {separating && (!separatingMode || separatingMode === '2stems')
                      ? `${t('music.separating')} ${formatSeconds(opElapsed)}`
                      : t('music.separate_stems')}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={separating}
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onSeparateStems('4stems');
                  }}
                >
                  {separating && separatingMode === '4stems' ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin" />
                  ) : (
                    <ScissorsIcon className="size-4 shrink-0" />
                  )}
                  <span className="truncate">
                    {separating && separatingMode === '4stems'
                      ? `${t('music.separating')} ${formatSeconds(opElapsed)}`
                      : t('music.separate_4stems')}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={separating}
                  className={menuItemClass}
                  onClick={() => {
                    setMenuOpen(false);
                    onSeparateStems('6stems');
                  }}
                >
                  {separating && separatingMode === '6stems' ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin" />
                  ) : (
                    <ScissorsIcon className="size-4 shrink-0" />
                  )}
                  <span className="truncate">
                    {separating && separatingMode === '6stems'
                      ? `${t('music.separating')} ${formatSeconds(opElapsed)}`
                      : t('music.separate_6stems')}
                  </span>
                </button>

                <div className="my-1 border-t border-border/50" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-destructive whitespace-nowrap transition-colors hover:bg-destructive/10"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  <Trash2Icon className="size-4 shrink-0" />
                  <span className="truncate">{t('music.delete_track')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        onPlayCapture={() => {
          if (track.listened === false) onMarkListened();
        }}
      >
        <WaveformPlayer src={apiPath(track.url)} />
      </div>

      {metaEditOpen && (
        <div className="space-y-3 rounded-lg border border-primary/30 bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">{t('music.edit_metadata')}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setMetaEditOpen(false)}
            >
              ×
            </Button>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-2">
              <label className="text-[11px] text-muted-foreground">{t('music.track_title_label')}</label>
              <Input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setSavingMeta(true);
                    try {
                      await onUpdateMetadata({
                        title: draftTitle.trim(),
                        prompt: draftPrompt.trim(),
                        lyrics: draftLyrics,
                        bpm: draftBpm.trim() ? Number(draftBpm) : null,
                        vocal_mode: draftVocalMode,
                      });
                      setMetaEditOpen(false);
                    } finally {
                      setSavingMeta(false);
                    }
                  }
                }}
                placeholder={t('music.track_title_placeholder')}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">{t('music.bpm_label')}</label>
              <Input
                type="number"
                min="30"
                max="260"
                value={draftBpm}
                onChange={(e) => setDraftBpm(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">{t('music.prompt_label')}</label>
            <Input
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDraftVocalMode('vocal')}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                draftVocalMode === 'vocal'
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border/60 text-muted-foreground'
              }`}
            >
              {t('music.vocal_mode_singing')}
            </button>
            <button
              type="button"
              onClick={() => setDraftVocalMode('instrumental')}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                draftVocalMode === 'instrumental'
                  ? 'border-amber-500/60 bg-amber-500/15 text-amber-400'
                  : 'border-border/60 text-muted-foreground'
              }`}
            >
              {t('music.vocal_mode_instrumental')}
            </button>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">{t('music.lyrics_label')}</label>
            <Textarea
              rows={3}
              value={draftLyrics}
              onChange={(e) => setDraftLyrics(e.target.value)}
              className="text-xs"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setMetaEditOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={savingMeta}
              onClick={async () => {
                setSavingMeta(true);
                try {
                  await onUpdateMetadata({
                    title: draftTitle.trim(),
                    prompt: draftPrompt.trim(),
                    lyrics: draftLyrics,
                    bpm: draftBpm.trim() ? Number(draftBpm) : null,
                    vocal_mode: draftVocalMode,
                  });
                  setMetaEditOpen(false);
                } finally {
                  setSavingMeta(false);
                }
              }}
            >
              {savingMeta ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t('music.save_metadata')}
            </Button>
          </div>
        </div>
      )}

      {lyricsOpen && track.lyrics && (
        <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/20 p-3 font-sans text-xs leading-relaxed text-foreground/90">
          {track.lyrics}
        </pre>
      )}

      {editOpen && (
        <div className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3">
          <div className="grid gap-3 sm:grid-cols-5">
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">
                {t('music.edit_trim_start')}
              </label>
              <Input
                type="number"
                min="0"
                step="0.5"
                value={trimStart}
                onChange={(e) => setTrimStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">
                {t('music.edit_trim_end')}
              </label>
              <Input
                type="number"
                min="0"
                step="0.5"
                value={trimEnd}
                onChange={(e) => setTrimEnd(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">
                {t('music.edit_speed')}
              </label>
              <Input
                type="number"
                min="0.5"
                max="2.0"
                step="0.05"
                value={speed}
                onChange={(e) => setSpeed(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">{t('music.edit_gain')}</label>
              <Input
                type="number"
                min="-24"
                max="24"
                step="1"
                value={gainDb}
                onChange={(e) => setGainDb(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">{t('music.edit_fade')}</label>
              <Input
                type="number"
                min="0"
                max="10"
                step="0.5"
                value={fadeSec}
                onChange={(e) => setFadeSec(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onRepaintSection(
                  Number(trimStart) || 0,
                  trimEnd.trim() ? Number(trimEnd) : null,
                )
              }
            >
              {t('music.repaint_section')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={editing}
              onClick={() =>
                onApplyEdit({
                  audio_url: track.url,
                  trim_start: Number(trimStart) || 0,
                  trim_end: trimEnd.trim() ? Number(trimEnd) : null,
                  speed: Number(speed) || 1.0,
                  gain_db: Number(gainDb) || 0,
                  fade_in: Number(fadeSec) || 0,
                  fade_out: Number(fadeSec) || 0,
                })
              }
            >
              {editing ? (
                <>
                  <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                  {t('music.editing')} {formatSeconds(opElapsed)}
                </>
              ) : (
                t('music.apply_edit')
              )}
            </Button>
          </div>
        </div>
      )}

      {track.stems && (
        <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium">{t('music.vocals_stem')}</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2.5 text-xs"
                  disabled={creatingProfile}
                  onClick={onCreateVoiceProfile}
                >
                  <UserPlusIcon className="mr-1 size-3" />
                  {creatingProfile ? t('music.creating_profile') : t('music.create_voice_profile')}
                </Button>
                <Link
                  to="/clone"
                  className="inline-flex items-center gap-1 text-xs text-primary underline"
                >
                  {t('music.send_to_clone')}
                </Link>
                <SaveAudioButton
                  url={apiPath(track.stems.vocals_url)}
                  suggestedName={`vocals-${track.id}.wav`}
                  iconOnly
                />
              </div>
            </div>
            <WaveformPlayer src={apiPath(track.stems.vocals_url)} />
          </div>

          {(
            [
              ['instrumental_url', t('music.instrumental_stem'), `instrumental-${track.id}.wav`],
              ['drums_url', t('music.drums_stem'), `drums-${track.id}.wav`],
              ['bass_url', t('music.bass_stem'), `bass-${track.id}.wav`],
              ['guitar_url', t('music.guitar_stem'), `guitar-${track.id}.wav`],
              ['piano_url', t('music.piano_stem'), `piano-${track.id}.wav`],
              ['other_url', t('music.other_stem'), `other-${track.id}.wav`],
            ] as const
          ).map(([field, label, filename]) => {
            const stemUrl = track.stems?.[field];
            if (!stemUrl) return null;
            return (
              <div key={field} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{label}</span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => onSendToMixer(label, stemUrl)}
                    >
                      <LayersIcon className="mr-1 size-3" />
                      {t('music.send_to_mixer')}
                    </Button>
                    <SaveAudioButton url={apiPath(stemUrl)} suggestedName={filename} iconOnly />
                  </div>
                </div>
                <WaveformPlayer src={apiPath(stemUrl)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
