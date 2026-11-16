import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  CopyIcon,
  DicesIcon,
  LayersIcon,
  Loader2Icon,
  MicIcon,
  MusicIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  ScissorsIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  ThumbsUpIcon,
  Trash2Icon,
  UploadIcon,
  VolumeXIcon,
  Wand2Icon,
} from 'lucide-react';
import { toast } from 'sonner';
// @ts-expect-error Shared JSX has no declaration file.
import SearchableSelect from '@shared/components/SearchableSelect';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import { WaveformPlayer } from '@/components/waveform-player';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch, apiJson, apiPath, describeError } from '@/lib/api/client';
import {
  JobProgressBanner,
  type DoneNotice,
  computeProgressPct,
  estimateGenerationSeconds,
  formatSeconds,
  useElapsedSeconds,
} from './job-progress';
import { MultitrackMixer, type MixerTrack } from './multitrack-mixer';
import {
  TrackCard,
  type EditAudioParams,
  type GeneratedTrack,
  type StemResult,
  type TrackMetadataPatch,
} from './track-card';

interface MusicStatus {
  installed: boolean;
  running: boolean;
  healthy: boolean;
  llm_initialized?: boolean;
  models_initialized?: boolean;
  loaded_model?: string | null;
  loaded_lm_model?: string | null;
  managed_pid: number | null;
  api_url: string;
  error: string | null;
}

interface MusicTaskResult {
  task_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  progress_text?: string | null;
  audio_urls: string[];
  duration?: number | null;
  analysis?: {
    prompt?: string;
    lyrics?: string;
    bpm?: number | null;
    duration?: number | null;
    vocal_language?: string;
    vocal_presence?: string;
    suggested_instrumental?: boolean;
    source?: string;
    lyrics_warning?: string;
    warning?: string;
  } | null;
  error?: string | null;
}

const MUSIC_STATUS_KEY = ['music-status'] as const;
const HISTORY_STORAGE_KEY = 'voicestudio.music.history';
const PERSONAS_STORAGE_KEY = 'voicestudio.music.personas';

interface MusicPersona {
  id: string;
  name: string;
  prompt: string;
  bpm: string;
  vocalLanguage: string;
  referenceAudioPath: string;
}

function loadPersonas(): MusicPersona[] {
  try {
    const raw = localStorage.getItem(PERSONAS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const MODEL_OPTIONS = [
  { value: 'acestep-v15-turbo', label: 'ACE-Step v1.5 Turbo (Fast)' },
  { value: 'acestep-v15-sft', label: 'ACE-Step v1.5 SFT (Quality)' },
  { value: 'acestep-v15-base', label: 'ACE-Step v1.5 Base' },
];

const FORMAT_OPTIONS = [
  { value: 'mp3', label: 'MP3' },
  { value: 'wav', label: 'WAV' },
  { value: 'flac', label: 'FLAC' },
];

const LANGUAGE_OPTIONS = [
  { value: 'pt', label: 'Português (pt)' },
  { value: 'en', label: 'English (en)' },
  { value: 'es', label: 'Español (es)' },
  { value: 'fr', label: 'Français (fr)' },
  { value: 'de', label: 'Deutsch (de)' },
  { value: 'it', label: 'Italiano (it)' },
  { value: 'ja', label: '日本語 (ja)' },
  { value: 'ko', label: '한국어 (ko)' },
  { value: 'zh', label: '中文 (zh)' },
];

const STYLE_PRESETS = [
  {
    label: 'Bossa Nova',
    bpm: '92',
    prompt: 'bossa nova, nylon acoustic guitar, brushed drums, warm upright bass, soft intimate vocals',
  },
  {
    label: 'MPB / Indie',
    bpm: '105',
    prompt: 'brazilian indie MPB, electric piano, clean chorus guitar, groovy bassline, expressive vocals',
  },
  {
    label: 'Sertanejo Acústico',
    bpm: '110',
    prompt: 'sertanejo universitario, acoustic steel guitar, accordion, warm emotional male vocals, modern drums',
  },
  {
    label: 'Trap / Funk BR',
    bpm: '130',
    prompt: 'brazilian trap funk fusion, heavy 808 sub bass, crisp hi-hats, melodic autotune vocals, dark synth pad',
  },
  {
    label: 'Synthpop 80s',
    bpm: '120',
    prompt: 'upbeat 80s synthpop, lush analog synths, punchy gated reverb drums, catchy melodic vocals',
  },
  {
    label: 'Lo-Fi Chill',
    bpm: '82',
    prompt: 'lo-fi hip hop chill beats, dusty vinyl crackle, warm rhodes chords, mellow bass, instrumental',
  },
  {
    label: 'Rock Alternativo',
    bpm: '136',
    prompt: 'alternative rock, distorted rhythm guitars, driving live drums, energetic vocals, anthemic chorus',
  },
];

const LYRIC_TAGS = ['[Verse]', '[Chorus]', '[Bridge]', '[Drop]', '[Guitar Solo]', '[Outro]'];
const DEFAULT_ADD_INST_PROMPT =
  'full band instrumental arrangement supporting clear lead vocals, rich drums, bass, guitars';

function appendUniqueTitleSuffix(title: string | null | undefined, suffix: string): string {
  const clean = (title || '').trim();
  if (!clean) return '';
  return clean.toLowerCase().endsWith(suffix.toLowerCase()) ? clean : `${clean} ${suffix}`;
}

function loadSavedTracks(): GeneratedTrack[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function MusicPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const refFileInputRef = useRef<HTMLInputElement | null>(null);

  const statusQuery = useQuery<MusicStatus>({
    queryKey: MUSIC_STATUS_KEY,
    queryFn: ({ signal }) => apiJson<MusicStatus>('/api/music/status', { signal }),
    refetchInterval: 4000,
  });

  const [showLogs, setShowLogs] = useState(false);
  const logsQuery = useQuery<{ lines: string[] }>({
    queryKey: ['music-logs'],
    queryFn: ({ signal }) => apiJson<{ lines: string[] }>('/api/music/logs?lines=80', { signal }),
    enabled: showLogs,
    refetchInterval: showLogs ? 3000 : false,
  });

  const [trackTitle, setTrackTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [taskType, setTaskType] = useState<'text2music' | 'cover'>('text2music');
  const [studioMode, setStudioMode] = useState<'create' | 'clone' | 'add_vocals' | 'add_inst'>(
    'create',
  );
  const [vocalMode, setVocalMode] = useState<'vocal' | 'instrumental'>('vocal');
  const [leftTab, setLeftTab] = useState<'create' | 'base' | 'advanced'>('create');
  const [selectedPreset, setSelectedPreset] = useState('');
  const [inferenceSteps, setInferenceSteps] = useState('8');
  const [guidanceScale, setGuidanceScale] = useState('7.0');
  const [model, setModel] = useState('acestep-v15-turbo');
  const [vocalLanguage, setVocalLanguage] = useState('pt');
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'wav' | 'flac'>('mp3');
  const [bpm, setBpm] = useState('120');
  const [duration, setDuration] = useState('30');
  const [durationMode, setDurationMode] = useState<'custom' | 'auto'>('custom');
  const [vocalGender, setVocalGender] = useState<'auto' | 'male' | 'female'>('auto');
  const [excludeStyles, setExcludeStyles] = useState('');
  const [maxMode, setMaxMode] = useState(false);
  const [weirdness, setWeirdness] = useState(50);
  const [styleInfluence, setStyleInfluence] = useState(50);
  const [variety, setVariety] = useState(50);
  const [usePersonalize, setUsePersonalize] = useState(true);
  const [seed, setSeed] = useState('-1');
  const [thinking, setThinking] = useState(true);
  const [longFormCoherence, setLongFormCoherence] = useState(true);
  const [useFormat, setUseFormat] = useState(false);
  const [unloadVram, setUnloadVram] = useState(true);
  const [srcAudioPath, setSrcAudioPath] = useState('');
  const [srcAudioPreviewUrl, setSrcAudioPreviewUrl] = useState('');
  const [referenceAudioPath, setReferenceAudioPath] = useState('');
  const [baseAudioUsage, setBaseAudioUsage] = useState<'reference' | 'cover'>('reference');
  const [coverStrength, setCoverStrength] = useState('0.65');
  const [coverNoiseStrength, setCoverNoiseStrength] = useState('0');
  const [repaintStart, setRepaintStart] = useState('0');
  const [repaintEnd, setRepaintEnd] = useState('');

  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeTaskId, setAnalyzeTaskId] = useState<string | null>(null);
  const lastAutoAnalyzedPromptRef = useRef<string>('');
  const [analysisFeedback, setAnalysisFeedback] = useState<{
    status: 'idle' | 'analyzing' | 'success' | 'error';
    detail: string;
  }>({ status: 'idle', detail: '' });
  const [randomBusy, setRandomBusy] = useState(false);
  const [enhancingLyrics, setEnhancingLyrics] = useState(false);
  const [creatingProfileId, setCreatingProfileId] = useState<string | null>(null);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [remasteringTrackId, setRemasteringTrackId] = useState<string | null>(null);
  const [sidecarBusy, setSidecarBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [separatingUrl, setSeparatingUrl] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState<string>('');
  const [tracks, setTracks] = useState<GeneratedTrack[]>(loadSavedTracks);
  const [personas, setPersonas] = useState<MusicPersona[]>(loadPersonas);
  const [mixerTracks, setMixerTracks] = useState<MixerTrack[]>([]);
  const [mixing, setMixing] = useState(false);
  const [extendBase, setExtendBase] = useState<{ url: string; continueAt: number } | null>(null);
  const [error, setError] = useState('');
  const [genStartedAt, setGenStartedAt] = useState<number | null>(null);
  const [genEstimateSec, setGenEstimateSec] = useState(30);
  const [genStage, setGenStage] = useState('');
  const [opStartedAt, setOpStartedAt] = useState<number | null>(null);
  const [activeOpLabel, setActiveOpLabel] = useState('');
  const [activeOpEstimateSec, setActiveOpEstimateSec] = useState(15);
  const [separatingMode, setSeparatingMode] = useState<'2stems' | '4stems' | '6stems' | null>(null);
  const [doneNotice, setDoneNotice] = useState<DoneNotice | null>(null);
  const [rightTab, setRightTab] = useState<'tracks' | 'studio' | 'mixer' | 'trash'>('tracks');
  const [studioTrackId, setStudioTrackId] = useState<string | null>(null);
  const [trackFilter, setTrackFilter] = useState<'all' | 'liked' | 'new'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [prefStats, setPrefStats] = useState<{ likes_count: number; dislikes_count: number }>({
    likes_count: 0,
    dislikes_count: 0,
  });
  const [trashTracks, setTrashTracks] = useState<
    Array<{
      id: string;
      url: string;
      filename: string;
      format: string;
      size_bytes: number;
      title?: string | null;
      prompt?: string;
      bpm?: number | null;
      duration?: number | null;
      vocal_mode?: 'vocal' | 'instrumental';
    }>
  >([]);
  const [latestTrackId, setLatestTrackId] = useState<string | null>(null);
  const [syncingLibrary, setSyncingLibrary] = useState(false);
  const [jobHistory, setJobHistory] = useState<
    Array<{
      id: string;
      label: string;
      status: 'running' | 'succeeded' | 'failed';
      timeStr: string;
      elapsedSec?: number;
      tracksCount?: number;
      error?: string;
    }>
  >([]);

  async function syncLibraryFromDisk() {
    setSyncingLibrary(true);
    try {
      const res = await apiJson<{
        tracks: Array<{
          id: string;
          url: string;
          filename: string;
          format: string;
          title?: string | null;
          prompt?: string;
          lyrics?: string;
          bpm?: number | null;
          duration?: number | null;
          vocal_language?: string;
          vocal_mode?: 'vocal' | 'instrumental';
          vocal_gender?: 'auto' | 'male' | 'female';
          exclude_styles?: string;
          duration_mode?: 'custom' | 'auto';
          max_mode?: boolean;
          weirdness?: number;
          style_influence?: number;
          variety?: number;
          model?: string;
          inference_steps?: number | null;
          guidance_scale?: number | null;
          seed?: number | null;
          rating?: 'like' | 'dislike' | null;
          listened?: boolean;
        }>;
      }>('/api/music/library?limit=40');
      if (res.tracks?.length) {
        const byUrl = new Map(res.tracks.map((item) => [item.url, item]));
        setTracks((prev) => {
          const updatedPrev = prev.map((existing) => {
            const disk = byUrl.get(existing.url);
            if (!disk) return existing;
            return {
              ...existing,
              title: disk.title ?? existing.title,
              prompt: disk.prompt || existing.prompt,
              lyrics: disk.lyrics ?? existing.lyrics,
              bpm: disk.bpm ?? existing.bpm,
              duration: disk.duration ?? existing.duration,
              vocalLanguage: disk.vocal_language ?? existing.vocalLanguage,
              vocalMode: disk.vocal_mode ?? existing.vocalMode,
              vocalGender: disk.vocal_gender ?? existing.vocalGender,
              excludeStyles: disk.exclude_styles ?? existing.excludeStyles,
              durationMode: disk.duration_mode ?? existing.durationMode,
              maxMode: disk.max_mode ?? existing.maxMode,
              weirdness: disk.weirdness ?? existing.weirdness,
              styleInfluence: disk.style_influence ?? existing.styleInfluence,
              variety: disk.variety ?? existing.variety,
              model: disk.model ?? existing.model,
              inferenceSteps: disk.inference_steps ?? existing.inferenceSteps,
              guidanceScale: disk.guidance_scale ?? existing.guidanceScale,
              seed: disk.seed ?? existing.seed,
              rating: disk.rating ?? existing.rating,
              listened: disk.listened ?? existing.listened,
            };
          });
          const seen = new Set(updatedPrev.map((item) => item.url));
          const missing: GeneratedTrack[] = res.tracks
            .filter((diskItem) => !seen.has(diskItem.url))
            .map((diskItem) => ({
              id: diskItem.id,
              url: diskItem.url,
              title: diskItem.title ?? null,
              prompt: diskItem.prompt || diskItem.filename,
              lyrics: diskItem.lyrics,
              bpm: diskItem.bpm ?? null,
              duration: diskItem.duration ?? null,
              vocalLanguage: diskItem.vocal_language,
              vocalMode: diskItem.vocal_mode,
              vocalGender: diskItem.vocal_gender,
              excludeStyles: diskItem.exclude_styles,
              durationMode: diskItem.duration_mode,
              maxMode: diskItem.max_mode,
              weirdness: diskItem.weirdness,
              styleInfluence: diskItem.style_influence,
              variety: diskItem.variety,
              model: diskItem.model,
              inferenceSteps: diskItem.inference_steps ?? null,
              guidanceScale: diskItem.guidance_scale ?? null,
              seed: diskItem.seed ?? null,
              rating: diskItem.rating ?? null,
              listened: diskItem.listened ?? true,
              format: diskItem.format || 'mp3',
            }));
          return missing.length > 0 ? [...updatedPrev, ...missing] : updatedPrev;
        });
      }
    } catch {
      // Ignore transient startup errors
    } finally {
      setSyncingLibrary(false);
    }
  }

  async function syncTrashFromDisk() {
    try {
      const res = await apiJson<{
        tracks: Array<{
          id: string;
          url: string;
          filename: string;
          format: string;
          size_bytes: number;
        }>;
      }>('/api/music/trash');
      setTrashTracks(res.tracks ?? []);
    } catch {
      // Ignore transient errors
    }
  }

  async function handleDeleteTrack(track: GeneratedTrack) {
    setTracks((prev) => prev.filter((x) => x.id !== track.id));
    if (studioTrackId === track.id) setStudioTrackId(null);
    try {
      const res = await apiJson<{ trashed: boolean; filename?: string }>('/api/music/trash/move', {
        method: 'POST',
        body: JSON.stringify({ audio_url: track.url }),
      });
      await syncTrashFromDisk();
      if (res.trashed) {
        toast.success(t('music.moved_to_trash'));
      }
    } catch (err) {
      setTracks((prev) => [track, ...prev]);
      setError(describeError(err));
    }
  }

  async function handleRestoreTrack(item: {
    id: string;
    url: string;
    filename: string;
    format: string;
    title?: string | null;
    prompt?: string;
  }) {
    try {
      const res = await apiJson<{
        audio_url: string;
        filename: string;
        metadata?: Record<string, unknown>;
      }>('/api/music/trash/restore', {
        method: 'POST',
        body: JSON.stringify({ audio_url: item.url }),
      });
      const meta = res.metadata || {};
      setTrashTracks((prev) => prev.filter((x) => x.id !== item.id));
      setTracks((prev) => [
        {
          id: `restored-${Date.now().toString(36)}`,
          url: res.audio_url,
          title: (meta.title as string | null) ?? item.title ?? null,
          prompt: (meta.prompt as string) || item.prompt || res.filename,
          lyrics: meta.lyrics as string | undefined,
          bpm: (meta.bpm as number | null) ?? null,
          duration: (meta.duration as number | null) ?? null,
          vocalLanguage: meta.vocal_language as string | undefined,
          vocalMode: meta.vocal_mode as 'vocal' | 'instrumental' | undefined,
          model: meta.model as string | undefined,
          rating: (meta.rating as 'like' | 'dislike' | null) ?? null,
          format: item.format || 'mp3',
        },
        ...prev,
      ]);
      toast.success(t('music.restored_from_trash'));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function handleDeleteTrashItem(item: { id: string; filename: string }) {
    try {
      await apiJson(`/api/music/trash/${encodeURIComponent(item.filename)}`, {
        method: 'DELETE',
      });
      setTrashTracks((prev) => prev.filter((x) => x.id !== item.id));
      toast.success(t('music.deleted_permanently'));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function handleRateTrack(track: GeneratedTrack, rating: 'like' | 'dislike' | 'none') {
    const nextRating = rating === 'none' ? null : rating;
    setTracks((prev) => prev.map((x) => (x.id === track.id ? { ...x, rating: nextRating } : x)));
    const filename = track.url.split('?')[0].split('/').pop();
    if (!filename) return;
    try {
      await apiJson(`/api/music/tracks/${encodeURIComponent(filename)}`, {
        method: 'PATCH',
        body: JSON.stringify({ rating }),
      });
      await syncPreferences();
      if (rating === 'dislike') {
        toast.info(t('music.dislike_learned_toast'));
      }
    } catch {
      // Keep optimistic UI rating even if file is not on disk
    }
  }

  async function handleUpdateTrackMetadata(track: GeneratedTrack, patch: TrackMetadataPatch) {
    setTracks((prev) =>
      prev.map((x) =>
        x.id === track.id
          ? {
            ...x,
            title: patch.title !== undefined ? patch.title || null : x.title,
            prompt: patch.prompt !== undefined ? patch.prompt : x.prompt,
            lyrics: patch.lyrics !== undefined ? patch.lyrics : x.lyrics,
            bpm: patch.bpm !== undefined ? patch.bpm : x.bpm,
            vocalMode: patch.vocal_mode !== undefined ? patch.vocal_mode : x.vocalMode,
          }
          : x,
      ),
    );
    const filename = track.url.split('?')[0].split('/').pop();
    if (!filename) return;
    try {
      await apiJson(`/api/music/tracks/${encodeURIComponent(filename)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      toast.success(t('music.metadata_saved'));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function handleMarkListened(track: GeneratedTrack) {
    setTracks((prev) => prev.map((x) => (x.id === track.id ? { ...x, listened: true } : x)));
    const filename = track.url.split('?')[0].split('/').pop();
    if (!filename) return;
    try {
      await apiJson(`/api/music/tracks/${encodeURIComponent(filename)}`, {
        method: 'PATCH',
        body: JSON.stringify({ listened: true }),
      });
    } catch {
      // Ignore if file is transient
    }
  }

  async function handleCloneTrack(track: GeneratedTrack) {
    setError('');
    try {
      const resolved = await apiJson<{ path: string }>('/api/music/resolve-output', {
        method: 'POST',
        body: JSON.stringify({ audio_url: track.url }),
      });
      setStudioMode('clone');
      setTaskType('cover');
      setBaseAudioUsage('cover');
      setSrcAudioPath(resolved.path);
      setSrcAudioPreviewUrl(track.url);
      if (track.title) setTrackTitle(appendUniqueTitleSuffix(track.title, '(Clone)'));
      if (track.prompt) setPrompt(track.prompt);
      if (track.lyrics !== undefined) setLyrics(track.lyrics);
      if (track.bpm) setBpm(String(track.bpm));
      if (track.duration && track.duration > 0) {
        setDuration(String(Math.round(track.duration)));
        setDurationMode('custom');
      }
      if (track.vocalLanguage) setVocalLanguage(track.vocalLanguage);
      if (track.vocalMode) setVocalMode(track.vocalMode);
      if (track.vocalGender) setVocalGender(track.vocalGender);
      if (track.excludeStyles !== undefined) setExcludeStyles(track.excludeStyles);
      if (track.maxMode !== undefined) setMaxMode(track.maxMode);
      if (track.weirdness !== undefined) setWeirdness(track.weirdness);
      if (track.styleInfluence !== undefined) setStyleInfluence(track.styleInfluence);
      if (track.variety !== undefined) setVariety(track.variety);
      setRepaintStart('0');
      setRepaintEnd('');
      setExtendBase(null);
      setLeftTab('create');
      if (!track.lyrics && status?.healthy) {
        void handleAnalyzeSongForPath(resolved.path);
      }
      toast.success(t('music.clone_loaded'));
    } catch (err) {
      setError(describeError(err));
    }
  }

  function handleOpenInStudio(track: GeneratedTrack) {
    setStudioTrackId(track.id);
    setRightTab('studio');
  }

  async function handleEmptyTrash() {
    try {
      await apiJson('/api/music/trash', { method: 'DELETE' });
      setTrashTracks([]);
      toast.success(t('music.trash_emptied'));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function syncPreferences() {
    try {
      const res = await apiJson<{ likes_count: number; dislikes_count: number }>(
        '/api/music/preferences',
      );
      setPrefStats(res);
    } catch {
      // Ignore transient errors
    }
  }

  useEffect(() => {
    void syncLibraryFromDisk();
    void syncTrashFromDisk();
    void syncPreferences();
  }, []);

  const genElapsed = useElapsedSeconds(generating, genStartedAt);
  const anyOpBusy =
    analyzing ||
    enhancingLyrics ||
    Boolean(separatingUrl) ||
    Boolean(remasteringTrackId) ||
    Boolean(editingTrackId) ||
    Boolean(creatingProfileId) ||
    mixing;
  const opElapsed = useElapsedSeconds(anyOpBusy, opStartedAt);

  useEffect(() => {
    if (!doneNotice) return;
    const timer = setTimeout(() => setDoneNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [doneNotice]);

  function startOpTimer(label: string, estimateSec: number) {
    setDoneNotice(null);
    setActiveOpLabel(label);
    setActiveOpEstimateSec(estimateSec);
    setOpStartedAt(Date.now());
  }

  function finishOpTimer(label?: string) {
    if (label && opStartedAt) {
      const elapsedSec = Math.max(1, Math.round((Date.now() - opStartedAt) / 1000));
      setDoneNotice({ label, elapsedSec });
    }
    setOpStartedAt(null);
    setActiveOpLabel('');
  }

  const status = statusQuery.data;

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(tracks.slice(0, 20)));
    } catch {
      // Ignore storage quota errors
    }
  }, [tracks]);

  useEffect(() => {
    try {
      localStorage.setItem(PERSONAS_STORAGE_KEY, JSON.stringify(personas.slice(0, 30)));
    } catch {
      // Ignore storage quota errors
    }
  }, [personas]);

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const res = await apiJson<MusicTaskResult>(`/api/music/tasks/${encodeURIComponent(taskId)}`);
        if (!active) return;
        setTaskStatus(res.status);
        if ((res.status === 'running' || res.status === 'pending') && res.progress_text) {
          setGenStage(res.progress_text);
        }
        if (res.status === 'succeeded') {
          let finalUrls = res.audio_urls;
          let stitchedDuration: number | null = null;
          if (extendBase && res.audio_urls.length > 0) {
            setGenStage(t('music.stage_stitching'));
            try {
              const stitched = await apiJson<{ audio_url: string; duration?: number | null }>('/api/music/stitch', {
                method: 'POST',
                body: JSON.stringify({
                  base_audio_url: extendBase.url,
                  extension_audio_url: res.audio_urls[0],
                  continue_at: extendBase.continueAt,
                }),
              });
              finalUrls = [stitched.audio_url, ...res.audio_urls];
              stitchedDuration = stitched.duration ?? null;
            } catch {
              // Keep raw extension if stitch fails
            }
            setExtendBase(null);
          }

          const elapsedSec = genStartedAt
            ? Math.max(1, Math.round((Date.now() - genStartedAt) / 1000))
            : 1;

          if (finalUrls.length === 0) {
            const noAudioMsg = res.error || t('music.no_audio_returned');
            setError(noAudioMsg);
            setJobHistory((prev) =>
              prev.map((j) =>
                j.id === taskId ? { ...j, status: 'failed', elapsedSec, error: noAudioMsg } : j,
              ),
            );
            toast.error(noAudioMsg);
          } else {
            const newTracks: GeneratedTrack[] = finalUrls.map((url, idx) => ({
              id: `${taskId}-${idx}`,
              url,
              title: trackTitle.trim() || null,
              prompt,
              lyrics: vocalMode === 'instrumental' ? '' : lyrics,
              bpm: bpm ? Number(bpm) : null,
              duration:
                idx === 0 && stitchedDuration && stitchedDuration > 0
                  ? stitchedDuration
                  : res.duration && res.duration > 0
                    ? res.duration
                    : durationMode === 'auto'
                      ? null
                      : duration
                        ? Number(duration)
                        : null,
              vocalLanguage,
              vocalMode,
              vocalGender,
              excludeStyles: excludeStyles.trim(),
              durationMode,
              maxMode,
              weirdness,
              styleInfluence,
              variety,
              model,
              inferenceSteps: Number(inferenceSteps) || 8,
              guidanceScale: Number(guidanceScale) || 7.0,
              seed: seed ? Number(seed) : -1,
              rating: null,
              listened: false,
              format: audioFormat,
            }));
            setTracks((prev) => [...newTracks, ...prev]);
            setLatestTrackId(newTracks[0].id);
            setRightTab('tracks');
            setDoneNotice({ label: t('music.generate'), elapsedSec });
            setJobHistory((prev) =>
              prev.map((j) =>
                j.id === taskId
                  ? { ...j, status: 'succeeded', elapsedSec, tracksCount: newTracks.length }
                  : j,
              ),
            );
            void syncLibraryFromDisk();
            toast.success(t('music.done_in', { time: formatSeconds(elapsedSec) }));
          }

          setGenerating(false);
          setGenStartedAt(null);
          setGenStage('');
          setTaskId(null);
        } else if (res.status === 'failed') {
          const errMsg = res.error || 'ACE-Step generation failed.';
          const elapsedSec = genStartedAt
            ? Math.max(1, Math.round((Date.now() - genStartedAt) / 1000))
            : undefined;
          setError(errMsg);
          setJobHistory((prev) =>
            prev.map((j) =>
              j.id === taskId ? { ...j, status: 'failed', elapsedSec, error: errMsg } : j,
            ),
          );
          setGenerating(false);
          setGenStartedAt(null);
          setGenStage('');
          setTaskId(null);
        }
      } catch (err) {
        if (!active) return;
        setError(describeError(err));
        setGenerating(false);
        setGenStartedAt(null);
        setGenStage('');
        setTaskId(null);
      }
    }, 2500);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [taskId, prompt, audioFormat, lyrics, bpm, duration, vocalLanguage, model, extendBase]);

  useEffect(() => {
    if (!analyzeTaskId) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const res = await apiJson<MusicTaskResult>(
          `/api/music/tasks/${encodeURIComponent(analyzeTaskId)}`,
        );
        if (!active) return;
        if (res.status === 'succeeded') {
          const extractedLyrics = (res.analysis?.lyrics || '').trim();
          const extractedPrompt = (res.analysis?.prompt || '').trim();
          const trimmedPrompt = prompt.trim();
          if (
            extractedPrompt &&
            (!trimmedPrompt ||
              trimmedPrompt === DEFAULT_ADD_INST_PROMPT ||
              trimmedPrompt === lastAutoAnalyzedPromptRef.current)
          ) {
            setPrompt(extractedPrompt);
            lastAutoAnalyzedPromptRef.current = extractedPrompt;
          }
          if (extractedLyrics) setLyrics(extractedLyrics);
          if (res.analysis?.bpm) setBpm(String(res.analysis.bpm));
          if (res.analysis?.duration && durationMode === 'custom') {
            setDuration(String(Math.round(res.analysis.duration)));
          }
          if (res.analysis?.vocal_language) setVocalLanguage(res.analysis.vocal_language);

          const lyricsWarn = (res.analysis?.lyrics_warning || '').trim();
          const isInstAudio =
            Boolean(res.analysis?.suggested_instrumental) ||
            res.analysis?.vocal_presence === 'instrumental_heavy';
          if (extractedLyrics) {
            const parts: string[] = [
              `${t('music.analysis_lyrics_ok')} (${extractedLyrics.length})`,
            ];
            if (extractedPrompt) parts.push(t('music.analysis_style_ok'));
            if (res.analysis?.bpm) parts.push(`${res.analysis.bpm} BPM`);
            const summary = parts.join(' · ');
            setAnalysisFeedback({ status: 'success', detail: summary });
            toast.success(`${t('music.analysis_done')}: ${summary}`);
          } else if (isInstAudio && extractedPrompt) {
            const parts: string[] = [t('music.analysis_style_ok'), t('music.instrumental_stem')];
            if (res.analysis?.bpm) parts.push(`${res.analysis.bpm} BPM`);
            const summary = parts.join(' · ');
            setAnalysisFeedback({ status: 'success', detail: summary });
            toast.success(`${t('music.analysis_done')}: ${summary}`);
          } else if (lyricsWarn) {
            const prefix = res.analysis?.bpm ? `${res.analysis.bpm} BPM · ` : '';
            const msg = `${prefix}${lyricsWarn}`;
            setAnalysisFeedback({ status: 'error', detail: msg });
            toast.warning(msg);
          } else if (extractedPrompt) {
            const parts: string[] = [t('music.analysis_style_ok')];
            if (res.analysis?.bpm) parts.push(`${res.analysis.bpm} BPM`);
            const summary = parts.join(' · ');
            setAnalysisFeedback({ status: 'success', detail: summary });
            toast.success(`${t('music.analysis_done')}: ${summary}`);
          } else {
            const msg = res.error || t('music.analysis_empty_error');
            setAnalysisFeedback({ status: 'error', detail: msg });
            setError(msg);
            toast.error(msg);
          }
          finishOpTimer(t('music.analyze_song'));
          setAnalyzing(false);
          setAnalyzeTaskId(null);
        } else if (res.status === 'failed') {
          const msg = res.error || t('music.analysis_empty_error');
          setAnalysisFeedback({ status: 'error', detail: msg });
          setError(msg);
          toast.error(msg);
          finishOpTimer();
          setAnalyzing(false);
          setAnalyzeTaskId(null);
        }
      } catch (err) {
        if (!active) return;
        const msg = describeError(err);
        setAnalysisFeedback({ status: 'error', detail: msg });
        setError(msg);
        toast.error(msg);
        finishOpTimer();
        setAnalyzing(false);
        setAnalyzeTaskId(null);
      }
    }, 800);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [analyzeTaskId, t]);

  async function handleStartSidecar() {
    setError('');
    setSidecarBusy(true);
    try {
      await apiJson('/api/music/sidecar/start', { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: MUSIC_STATUS_KEY });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSidecarBusy(false);
    }
  }

  async function handleStopSidecar() {
    setError('');
    setSidecarBusy(true);
    try {
      await apiJson('/api/music/sidecar/stop', { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: MUSIC_STATUS_KEY });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSidecarBusy(false);
    }
  }

  function resetBaseAudioContext() {
    setSrcAudioPath('');
    setSrcAudioPreviewUrl('');
    setReferenceAudioPath('');
    setStudioMode('create');
    setBaseAudioUsage('reference');
    setTaskType('text2music');
    setRepaintStart('0');
    setRepaintEnd('');
    setExtendBase(null);
    setAnalysisFeedback({ status: 'idle', detail: '' });
  }

  async function handleUploadSource(file: File, target: 'source' | 'reference' = 'source') {
    setError('');
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch('/api/music/upload-source', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = (await res.json()) as { path: string; audio_url?: string };
      if (target === 'reference') {
        setReferenceAudioPath(data.path);
      } else {
        setSrcAudioPath(data.path);
        if (data.audio_url) setSrcAudioPreviewUrl(data.audio_url);
        setRepaintStart('0');
        setRepaintEnd('');
        setExtendBase(null);
        setLeftTab('create');
        void handleAnalyzeSongForPath(data.path);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleAnalyzeSongForPath(targetPath: string) {
    if (!targetPath.trim()) return;
    setError('');
    setAnalyzing(true);
    setAnalysisFeedback({ status: 'analyzing', detail: t('music.analyzing_song') });
    startOpTimer(t('music.analyzing_song'), 25);
    try {
      const res = await apiJson<{ task_id: string }>('/api/music/analyze', {
        method: 'POST',
        body: JSON.stringify({ src_audio_path: targetPath.trim() }),
      });
      setAnalyzeTaskId(res.task_id);
    } catch (err) {
      const msg = describeError(err);
      setAnalysisFeedback({ status: 'error', detail: msg });
      setError(msg);
      toast.error(msg);
      finishOpTimer();
      setAnalyzing(false);
    }
  }

  async function handleAnalyzeSong() {
    await handleAnalyzeSongForPath(srcAudioPath);
  }

  async function handleSeparateStems(track: GeneratedTrack, mode: '2stems' | '4stems' | '6stems') {
    setError('');
    setSeparatingUrl(track.url);
    setSeparatingMode(mode);
    const stemLabel =
      mode === '6stems'
        ? t('music.separate_6stems')
        : mode === '4stems'
          ? t('music.separate_4stems')
          : t('music.separate_stems');
    startOpTimer(stemLabel, mode === '6stems' ? 35 : mode === '4stems' ? 25 : 18);
    try {
      const stems = await apiJson<StemResult>('/api/music/separate', {
        method: 'POST',
        body: JSON.stringify({ audio_url: track.url, mode }),
      });
      setTracks((prev) =>
        prev.map((item) => (item.id === track.id ? { ...item, stems } : item)),
      );
      finishOpTimer(stemLabel);
    } catch (err) {
      setError(describeError(err));
      finishOpTimer();
    } finally {
      setSeparatingUrl(null);
      setSeparatingMode(null);
    }
  }

  async function handleEnhanceLyrics() {
    setError('');
    setEnhancingLyrics(true);
    startOpTimer(t('music.enhancing_lyrics'), 25);
    try {
      const res = await apiJson<Record<string, unknown>>('/api/music/format-lyrics', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          lyrics,
          bpm: bpm ? Number(bpm) : null,
          duration: duration ? Number(duration) : null,
          vocal_language: vocalLanguage,
        }),
      });
      if (typeof res.caption === 'string' && res.caption) setPrompt(res.caption);
      if (typeof res.lyrics === 'string' && res.lyrics) setLyrics(res.lyrics);
      if (typeof res.bpm === 'number') setBpm(String(res.bpm));
      if (typeof res.duration === 'number' && durationMode === 'custom') {
        setDuration(String(Math.round(res.duration)));
      }
      toast.success(t('music.lyrics_enhanced'));
      finishOpTimer(t('music.enhance_lyrics'));
    } catch (err) {
      setError(describeError(err));
      finishOpTimer();
    } finally {
      setEnhancingLyrics(false);
    }
  }

  async function handleRandomSample() {
    setError('');
    setRandomBusy(true);
    try {
      const sample = await apiJson<Record<string, unknown>>('/api/music/random-sample', {
        method: 'POST',
      });
      if (typeof sample.caption === 'string' && sample.caption) setPrompt(sample.caption);
      else if (typeof sample.prompt === 'string' && sample.prompt) setPrompt(sample.prompt);
      if (typeof sample.lyrics === 'string') setLyrics(sample.lyrics);
      if (typeof sample.bpm === 'number') setBpm(String(sample.bpm));
      if (typeof sample.duration === 'number') setDuration(String(sample.duration));
      if (typeof sample.vocal_language === 'string' && sample.vocal_language) {
        setVocalLanguage(sample.vocal_language);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRandomBusy(false);
    }
  }

  async function handleUseAsCover(
    track: GeneratedTrack,
    opts?: { keepRepaint?: boolean; keepExtend?: boolean; keepNoise?: boolean; titleSuffix?: string | null },
  ) {
    setError('');
    try {
      const resolved = await apiJson<{ path: string }>('/api/music/resolve-output', {
        method: 'POST',
        body: JSON.stringify({ audio_url: track.url }),
      });
      setStudioMode('clone');
      setTaskType('cover');
      setBaseAudioUsage('cover');
      setSrcAudioPath(resolved.path);
      setSrcAudioPreviewUrl(track.url);
      if (!opts?.keepRepaint) {
        setRepaintStart('0');
        setRepaintEnd('');
      }
      if (!opts?.keepExtend) {
        setExtendBase(null);
      }
      if (!opts?.keepNoise) {
        setCoverNoiseStrength('0');
      }
      const suffix = opts?.titleSuffix === undefined ? '(Cover)' : opts.titleSuffix;
      if (track.title && suffix) {
        setTrackTitle(appendUniqueTitleSuffix(track.title, suffix));
      } else if (track.title) {
        setTrackTitle(track.title);
      }
      if (track.prompt) setPrompt(track.prompt);
      if (track.lyrics) setLyrics(track.lyrics);
      setLeftTab('create');
      if (!track.lyrics) {
        void handleAnalyzeSongForPath(resolved.path);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function handleCreateVoiceProfile(track: GeneratedTrack) {
    if (!track.stems?.vocals_url) return;
    setError('');
    setCreatingProfileId(track.id);
    try {
      const audioRes = await apiFetch(track.stems.vocals_url);
      if (!audioRes.ok) throw new Error('Failed to load isolated vocal audio.');
      const blob = await audioRes.blob();
      const form = new FormData();
      form.append('name', `Vocal ${track.id.slice(0, 8)}`);
      form.append('ref_audio', blob, `vocal-${track.id}.wav`);
      form.append('ref_text', '');
      const res = await apiFetch('/profiles', { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      await queryClient.invalidateQueries({ queryKey: ['profiles'] });
      toast.success(t('music.profile_created'));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCreatingProfileId(null);
    }
  }

  function handleModelChange(nextModel: string) {
    setModel(nextModel);
    const nextIsTurbo = nextModel.toLowerCase().includes('turbo');
    const curSteps = Number(inferenceSteps) || 8;
    if (nextIsTurbo && curSteps === 32) {
      setInferenceSteps('8');
    } else if (!nextIsTurbo && curSteps === 8) {
      setInferenceSteps('32');
    }
  }

  async function handleRegenerate(track: GeneratedTrack) {
    setError('');
    setDoneNotice(null);
    const targetModel = track.model ?? model;
    const targetSteps = track.inferenceSteps ?? (Number(inferenceSteps) || (targetModel.includes('turbo') ? 8 : 32));
    const targetMaxMode = track.maxMode ?? maxMode;
    const targetDuration = track.duration ?? (durationMode === 'auto' ? 90 : Number(duration) || 30);
    const est = estimateGenerationSeconds({
      model: targetModel,
      durationSec: targetDuration,
      thinking,
      useFormat,
      steps: targetSteps,
      maxMode: targetMaxMode,
    });
    setGenEstimateSec(est);
    setGenStartedAt(Date.now());
    setGenStage(t('music.stage_submitting'));
    setGenerating(true);
    setTaskStatus('submitting');
    try {
      const targetVocalMode = track.vocalMode ?? vocalMode;
      const targetDurationMode = track.durationMode ?? (track.duration ? 'custom' : durationMode);
      const payload = {
        title: track.title ?? null,
        prompt: track.prompt,
        lyrics: targetVocalMode === 'instrumental' ? '[Instrumental]' : (track.lyrics ?? lyrics),
        studio_mode: 'create',
        vocal_mode: targetVocalMode,
        vocal_gender: track.vocalGender ?? vocalGender,
        exclude_styles: track.excludeStyles ?? excludeStyles.trim(),
        duration_mode: targetDurationMode,
        max_mode: targetMaxMode,
        weirdness: track.weirdness ?? weirdness,
        style_influence: track.styleInfluence ?? styleInfluence,
        variety: track.variety ?? variety,
        use_personalize: usePersonalize,
        task_type: 'text2music',
        model: targetModel,
        vocal_language: track.vocalLanguage ?? vocalLanguage,
        audio_format: (track.format as 'mp3' | 'wav' | 'flac') || audioFormat,
        bpm: track.bpm ?? (bpm ? Number(bpm) : null),
        audio_duration:
          track.duration && track.duration > 0
            ? track.duration
            : targetDurationMode === 'auto'
              ? -1
              : Number(duration) || 30,
        long_form_coherence: longFormCoherence,
        inference_steps: targetSteps,
        guidance_scale: track.guidanceScale ?? (Number(guidanceScale) || 7.0),
        seed: -1,
        thinking,
        use_format: useFormat,
        unload_vram: unloadVram,
      };
      const res = await apiJson<{ task_id: string }>('/api/music/generate', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setTaskId(res.task_id);
      setTaskStatus('running');
      setGenStage(t('music.stage_running'));
      setRightTab('tracks');
      setJobHistory((prev) => [
        {
          id: res.task_id,
          label: track.title || track.prompt.slice(0, 42) || t('music.generate'),
          status: 'running',
          timeStr: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
        ...prev.slice(0, 5),
      ]);
    } catch (err) {
      setError(describeError(err));
      setGenerating(false);
      setGenStartedAt(null);
      setGenStage('');
      setTaskStatus('');
    }
  }

  async function handleRemix(track: GeneratedTrack) {
    setCoverStrength('0.65');
    setCoverNoiseStrength('0.45');
    await handleUseAsCover(track, { keepNoise: true, titleSuffix: '(Remix)' });
  }

  async function handleRepaintSection(track: GeneratedTrack, startSec: number, endSec: number | null) {
    setRepaintStart(String(startSec));
    setRepaintEnd(endSec != null ? String(endSec) : '');
    await handleUseAsCover(track, { keepRepaint: true, titleSuffix: null });
  }

  async function handleExtendTrack(track: GeneratedTrack) {
    const baseDur = track.duration || Number(duration) || 30;
    setExtendBase({ url: track.url, continueAt: baseDur });
    setRepaintStart(String(baseDur));
    setRepaintEnd('');
    setDurationMode('custom');
    setDuration(String(Math.min(300, baseDur + 30)));
    setCoverStrength('0.85');
    await handleUseAsCover(track, { keepRepaint: true, keepExtend: true, titleSuffix: null });
  }

  async function handleSavePersona(track: GeneratedTrack) {
    setError('');
    try {
      const resolved = await apiJson<{ path: string }>('/api/music/resolve-output', {
        method: 'POST',
        body: JSON.stringify({ audio_url: track.url }),
      });
      const newPersona: MusicPersona = {
        id: `persona-${Date.now().toString(36)}`,
        name: track.prompt.slice(0, 26) || `Persona ${personas.length + 1}`,
        prompt: track.prompt,
        bpm: track.bpm ? String(track.bpm) : bpm,
        vocalLanguage: track.vocalLanguage || vocalLanguage,
        referenceAudioPath: resolved.path,
      };
      setPersonas((prev) => [newPersona, ...prev]);
      toast.success(t('music.persona_saved'));
    } catch (err) {
      setError(describeError(err));
    }
  }

  function handleSendToMixer(label: string, audioUrl: string) {
    setMixerTracks((prev) => [
      ...prev,
      {
        id: `mix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        label,
        audio_url: audioUrl,
        volume: 1.0,
        pan: 0.0,
        pitch_semitones: 0,
        start_sec: 0,
        mute: false,
      },
    ]);
  }

  async function handleMixMultitrack() {
    if (mixerTracks.length === 0) return;
    setError('');
    setMixing(true);
    startOpTimer(t('music.mixing'), 10);
    try {
      const res = await apiJson<{ audio_url: string; duration?: number | null }>('/api/music/mix-multitrack', {
        method: 'POST',
        body: JSON.stringify({
          tracks: mixerTracks.map(
            ({ audio_url, volume, pan, pitch_semitones, start_sec, mute }) => ({
              audio_url,
              volume,
              pan,
              pitch_semitones,
              start_sec,
              mute,
            }),
          ),
        }),
      });
      const mixedTrack: GeneratedTrack = {
        id: `mix-${Date.now().toString(36)}`,
        url: res.audio_url,
        title: `Multitrack Mix (${mixerTracks.length} faixas)`,
        prompt: `Multitrack Mix (${mixerTracks.length} faixas)`,
        duration: res.duration ?? null,
        format: 'mp3',
        rating: null,
        listened: false,
      };
      setTracks((prev) => [mixedTrack, ...prev]);
      setLatestTrackId(mixedTrack.id);
      setRightTab('tracks');
      toast.success(t('music.mix_done'));
      finishOpTimer(t('music.mix_export'));
    } catch (err) {
      setError(describeError(err));
      finishOpTimer();
    } finally {
      setMixing(false);
    }
  }

  async function handleRemasterTrack(track: GeneratedTrack) {
    setError('');
    setRemasteringTrackId(track.id);
    startOpTimer(t('music.remastering'), 12);
    try {
      const res = await apiJson<{ audio_url: string; duration?: number | null }>('/api/music/remaster', {
        method: 'POST',
        body: JSON.stringify({ audio_url: track.url }),
      });
      const mastered: GeneratedTrack = {
        ...track,
        id: `${track.id}-master-${Date.now().toString(36)}`,
        url: res.audio_url,
        duration: res.duration ?? track.duration,
        rating: null,
        listened: false,
        stems: undefined,
      };
      setTracks((prev) => [mastered, ...prev]);
      setLatestTrackId(mastered.id);
      toast.success(t('music.remaster_done'));
      finishOpTimer(t('music.remaster'));
    } catch (err) {
      setError(describeError(err));
      finishOpTimer();
    } finally {
      setRemasteringTrackId(null);
    }
  }

  async function handleApplyEdit(track: GeneratedTrack, params: EditAudioParams) {
    setError('');
    setEditingTrackId(track.id);
    startOpTimer(t('music.editing'), 8);
    try {
      const res = await apiJson<{ audio_url: string; duration?: number | null }>('/api/music/edit-audio', {
        method: 'POST',
        body: JSON.stringify(params),
      });
      const editedTrack: GeneratedTrack = {
        ...track,
        id: `${track.id}-edit-${Date.now().toString(36)}`,
        url: res.audio_url,
        duration: res.duration ?? track.duration,
        rating: null,
        listened: false,
        stems: undefined,
      };
      setTracks((prev) => [editedTrack, ...prev]);
      setLatestTrackId(editedTrack.id);
      toast.success(t('music.edit_applied'));
      finishOpTimer(t('music.apply_edit'));
    } catch (err) {
      setError(describeError(err));
      finishOpTimer();
    } finally {
      setEditingTrackId(null);
    }
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setDoneNotice(null);
    const est = estimateGenerationSeconds({
      model,
      durationSec: durationMode === 'auto' ? 90 : duration ? Number(duration) : 30,
      thinking,
      useFormat,
      steps: Number(inferenceSteps) || 8,
      maxMode,
    });
    setGenEstimateSec(est);
    setGenStartedAt(Date.now());
    setGenStage(t('music.stage_submitting'));
    setGenerating(true);
    setTaskStatus('submitting');
    try {
      const hasBaseAudio = Boolean(srcAudioPath.trim());
      const useReferenceOnly = hasBaseAudio && baseAudioUsage === 'reference';
      const hasRepaintWindow =
        hasBaseAudio &&
        !useReferenceOnly &&
        ((Number(repaintStart) || 0) > 0 || repaintEnd.trim() !== '');
      const resolvedTaskType = hasRepaintWindow
        ? 'repaint'
        : hasBaseAudio && !useReferenceOnly
          ? 'cover'
          : taskType === 'cover' && !useReferenceOnly
            ? 'cover'
            : 'text2music';
      const effectiveStudioMode = !hasBaseAudio || useReferenceOnly ? 'create' : studioMode;
      const payload = {
        title: trackTitle.trim() || null,
        prompt,
        lyrics: vocalMode === 'instrumental' ? '[Instrumental]' : lyrics,
        studio_mode: effectiveStudioMode,
        vocal_mode: vocalMode,
        vocal_gender: vocalGender,
        exclude_styles: excludeStyles.trim(),
        duration_mode: durationMode,
        max_mode: maxMode,
        weirdness,
        style_influence: styleInfluence,
        variety,
        use_personalize: usePersonalize,
        task_type: resolvedTaskType,
        model,
        vocal_language: vocalLanguage,
        audio_format: audioFormat,
        bpm: bpm ? Number(bpm) : null,
        audio_duration: durationMode === 'auto' ? -1 : duration ? Number(duration) : 30,
        long_form_coherence: longFormCoherence,
        inference_steps: Number(inferenceSteps) || 8,
        guidance_scale: Number(guidanceScale) || 7.0,
        seed: seed ? Number(seed) : -1,
        thinking,
        use_format: useFormat,
        unload_vram: unloadVram,
        src_audio_path: hasBaseAudio && !useReferenceOnly ? srcAudioPath.trim() : null,
        reference_audio_path: useReferenceOnly
          ? referenceAudioPath.trim() || srcAudioPath.trim()
          : referenceAudioPath.trim()
            ? referenceAudioPath.trim()
            : null,
        audio_cover_strength:
          coverStrength.trim() !== '' && Number.isFinite(Number(coverStrength))
            ? Number(coverStrength)
            : 0.65,
        cover_noise_strength:
          coverNoiseStrength.trim() !== '' && Number.isFinite(Number(coverNoiseStrength))
            ? Number(coverNoiseStrength)
            : 0.0,
        repainting_start: Number(repaintStart) || 0.0,
        repainting_end: repaintEnd.trim() ? Number(repaintEnd) : null,
      };
      const res = await apiJson<{ task_id: string }>('/api/music/generate', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setTaskId(res.task_id);
      setTaskStatus('running');
      setGenStage(t('music.stage_running'));
      setRightTab('tracks');
      setJobHistory((prev) => [
        {
          id: res.task_id,
          label: trackTitle.trim() || prompt.slice(0, 42) || t('music.generate'),
          status: 'running',
          timeStr: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
        ...prev.slice(0, 5),
      ]);
    } catch (err) {
      setError(describeError(err));
      setGenerating(false);
      setGenStartedAt(null);
      setGenStage('');
      setTaskStatus('');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader>
        <div className="flex items-center gap-2">
          <MusicIcon className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">{t('music.title')}</h1>
        </div>
      </WorkspaceHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:overflow-hidden lg:p-5">
        <div className="shrink-0 space-y-3">
          {/* Sidecar status card */}
          <div className="space-y-3 rounded-xl border border-border/60 bg-card p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span
                    className={`size-2.5 rounded-full ${status?.healthy
                      ? 'bg-emerald-500'
                      : status?.running
                        ? 'bg-amber-500'
                        : 'bg-zinc-500'
                      }`}
                  />
                  <span>
                    {t('music.sidecar_label')}:{' '}
                    {status?.healthy
                      ? t('music.online')
                      : status?.running
                        ? t('music.starting')
                        : status?.installed === false
                          ? t('music.not_installed')
                          : t('music.offline')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{t('music.isolated_env')}</p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowLogs((v) => !v)}
                >
                  <TerminalIcon className="mr-1.5 size-3.5" />
                  {showLogs ? t('music.hide_logs') : t('music.show_logs')}
                </Button>
                {!status?.running ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={sidecarBusy || status?.installed === false}
                    onClick={handleStartSidecar}
                  >
                    <PlayIcon className="mr-1.5 size-3.5" />
                    {t('music.start_sidecar')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={sidecarBusy}
                    onClick={handleStopSidecar}
                  >
                    <SquareIcon className="mr-1.5 size-3.5" />
                    {t('music.stop_sidecar')}
                  </Button>
                )}
              </div>
            </div>

            {showLogs && (
              <pre className="max-h-48 overflow-y-auto rounded-lg bg-black/80 p-3 font-mono text-[11px] text-zinc-200">
                {(logsQuery.data?.lines ?? []).join('\n') || '---'}
              </pre>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {extendBase && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
              <span>
                Extend ativo a partir de <strong>{extendBase.continueAt}s</strong> ({extendBase.url})
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setExtendBase(null)}
              >
                ×
              </Button>
            </div>
          )}
        </div>

        {/* Two-column Suno-style workspace: Left = Config/Create, Right = Generated Tracks & Mixer */}
        <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[440px_minmax(0,1fr)] xl:grid-cols-[480px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col">
            {/* Generation Form */}
            <form
              onSubmit={handleGenerate}
              className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-card"
            >
              {/* Left Panel Tab Bar */}
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setLeftTab('create')}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${leftTab === 'create'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                  >
                    <SparklesIcon className="size-3.5" />
                    <span>{t('music.tab_create')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLeftTab('base')}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${leftTab === 'base'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                  >
                    <UploadIcon className="size-3.5" />
                    <span>{t('music.tab_base_audio')}</span>
                    {srcAudioPath && (
                      <span className="size-1.5 rounded-full bg-emerald-400" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setLeftTab('advanced')}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${leftTab === 'advanced'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                  >
                    <SlidersHorizontalIcon className="size-3.5" />
                    <span>{t('music.tab_advanced')}</span>
                  </button>
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-7 shrink-0 px-2.5 text-[11px]"
                  disabled={randomBusy || !status?.healthy}
                  onClick={() => void handleRandomSample()}
                >
                  <DicesIcon className="mr-1 size-3.5" />
                  {t('music.surprise_me')}
                </Button>
              </div>

              <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-3.5">
                {leftTab === 'create' && (
                  <>
                    {/* Vocal vs Instrumental Toggle */}
                    <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border/50 bg-muted/30 p-1">
                      <button
                        type="button"
                        onClick={() => setVocalMode('vocal')}
                        className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition-colors ${vocalMode === 'vocal'
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                      >
                        <MicIcon className="size-3.5" />
                        <span>{t('music.vocal_mode_singing')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setVocalMode('instrumental')}
                        className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition-colors ${vocalMode === 'instrumental'
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                      >
                        <VolumeXIcon className="size-3.5" />
                        <span>{t('music.vocal_mode_instrumental')}</span>
                      </button>
                    </div>

                    {/* Vocal Gender (only when singing vocals are enabled) */}
                    {vocalMode === 'vocal' && (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1.5">
                        <span className="text-[11px] font-semibold text-foreground">
                          {t('music.vocal_gender_label')}
                        </span>
                        <div className="flex items-center gap-1 rounded-md border border-border/50 bg-muted/30 p-0.5">
                          {(
                            [
                              { id: 'auto', label: t('music.gender_auto') },
                              { id: 'male', label: t('music.gender_male') },
                              { id: 'female', label: t('music.gender_female') },
                            ] as const
                          ).map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() =>
                                setVocalGender((prev) =>
                                  opt.id !== 'auto' && prev === opt.id ? 'auto' : opt.id,
                                )
                              }
                              className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                vocalGender === opt.id
                                  ? 'bg-primary text-primary-foreground shadow-sm'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 2x2 Mode Switcher */}
                    <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border/50 bg-muted/20 p-1">
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 justify-start px-2.5 text-xs"
                        variant={studioMode === 'create' ? 'default' : 'ghost'}
                        onClick={() => {
                          setStudioMode('create');
                          setTaskType('text2music');
                          setRepaintStart('0');
                          setRepaintEnd('');
                        }}
                      >
                        <span className="truncate">{t('music.mode_create')}</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 justify-start px-2.5 text-xs"
                        variant={studioMode === 'clone' ? 'default' : 'ghost'}
                        onClick={() => {
                          setStudioMode('clone');
                          setTaskType('cover');
                          if (!srcAudioPath) setLeftTab('base');
                        }}
                      >
                        <span className="truncate">{t('music.mode_clone')}</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 justify-start px-2.5 text-xs"
                        variant={studioMode === 'add_vocals' ? 'default' : 'ghost'}
                        onClick={() => {
                          setStudioMode('add_vocals');
                          setBaseAudioUsage('cover');
                          setTaskType('cover');
                          setVocalMode('vocal');
                          setCoverStrength('0.75');
                          setCoverNoiseStrength('0.2');
                          setPrompt((p) =>
                            p.includes('vocals') ? p : `${p}, expressive lead vocals`,
                          );
                          if (!srcAudioPath) setLeftTab('base');
                        }}
                      >
                        <span className="truncate">{t('music.mode_add_vocals')}</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 justify-start px-2.5 text-xs"
                        variant={studioMode === 'add_inst' ? 'default' : 'ghost'}
                        onClick={() => {
                          setStudioMode('add_inst');
                          setBaseAudioUsage('cover');
                          setTaskType('cover');
                          setVocalMode('vocal');
                          setCoverStrength('0.72');
                          setCoverNoiseStrength('0.15');
                          if (!prompt.trim()) {
                            setPrompt(DEFAULT_ADD_INST_PROMPT);
                          }
                          if (!srcAudioPath) setLeftTab('base');
                        }}
                      >
                        <span className="truncate">{t('music.mode_add_inst')}</span>
                      </Button>
                    </div>

                    {/* Active Base Audio visible directly on the Create screen */}
                    {(srcAudioPath || referenceAudioPath) && (
                      <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <UploadIcon className="size-3.5 shrink-0 text-primary" />
                            <span className="truncate text-xs font-semibold text-foreground">
                              {t('music.base_audio_active')}:{' '}
                              {(srcAudioPath || referenceAudioPath).split(/[\\/]/).pop()}
                            </span>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                            onClick={resetBaseAudioContext}
                          >
                            ×
                          </Button>
                        </div>

                        {srcAudioPreviewUrl && (
                          <WaveformPlayer src={apiPath(srcAudioPreviewUrl)} compact />
                        )}

                        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                          <button
                            type="button"
                            onClick={() => {
                              setStudioMode('create');
                              setBaseAudioUsage('reference');
                              setTaskType('text2music');
                              setRepaintStart('0');
                              setRepaintEnd('');
                              setExtendBase(null);
                            }}
                            className={`rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                              baseAudioUsage === 'reference'
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-border/60 text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.base_usage_reference')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setStudioMode('clone');
                              setBaseAudioUsage('cover');
                              setTaskType('cover');
                            }}
                            className={`rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                              baseAudioUsage === 'cover' && studioMode !== 'add_inst'
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-border/60 text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.base_usage_cover')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setStudioMode('add_inst');
                              setBaseAudioUsage('cover');
                              setTaskType('cover');
                              setVocalMode('vocal');
                              setCoverStrength('0.65');
                              setCoverNoiseStrength('0.15');
                            }}
                            className={`rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                              baseAudioUsage === 'cover' && studioMode === 'add_inst'
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-border/60 text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.mode_add_inst')}
                          </button>
                        </div>
                        {(analyzing || analysisFeedback.status !== 'idle') && (
                          <div
                            className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[11px] ${
                              analyzing || analysisFeedback.status === 'analyzing'
                                ? 'border-primary/30 bg-primary/10 text-primary'
                                : analysisFeedback.status === 'success'
                                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                                  : 'border-destructive/40 bg-destructive/10 text-destructive'
                            }`}
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              {analyzing || analysisFeedback.status === 'analyzing' ? (
                                <Loader2Icon className="size-3 shrink-0 animate-spin" />
                              ) : analysisFeedback.status === 'success' ? (
                                <CheckCircle2Icon className="size-3 shrink-0" />
                              ) : (
                                <AlertCircleIcon className="size-3 shrink-0" />
                              )}
                              <span className="truncate">
                                {analyzing
                                  ? t('music.analyzing_song')
                                  : analysisFeedback.detail}
                              </span>
                            </div>
                            {!analyzing && srcAudioPath.trim() && (
                              <button
                                type="button"
                                onClick={() => void handleAnalyzeSong()}
                                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold underline-offset-2 hover:underline"
                              >
                                {t('music.analyze_song')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Track Title (Pre-creation Metadata) */}
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">
                        {t('music.track_title_label')}
                      </label>
                      <Input
                        value={trackTitle}
                        onChange={(e) => setTrackTitle(e.target.value)}
                        className="h-9 text-xs"
                      />
                    </div>

                    {/* Quick Styles in 1 single SearchableSelect */}
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">
                        {t('music.presets_label')}
                      </label>
                      <SearchableSelect
                        value={selectedPreset}
                        onChange={(val: string) => {
                          setSelectedPreset(val);
                          const found = STYLE_PRESETS.find((p) => p.label === val);
                          if (found) {
                            setPrompt(found.prompt);
                            setBpm(found.bpm);
                          }
                        }}
                        options={STYLE_PRESETS.map((p) => ({
                          value: p.label,
                          label: `${p.label} (${p.bpm} BPM)`,
                        }))}
                        placeholder="—"
                        ariaLabel={t('music.presets_label')}
                      />
                    </div>

                    {/* Style Prompt */}
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">
                        {t('music.prompt_label')}
                      </label>
                      <Input
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        className="h-9 text-xs"
                        required
                      />
                    </div>

                    {/* Duration Control */}
                    <div className="space-y-2 rounded-lg border border-border/50 bg-background/40 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-xs font-semibold text-foreground">
                          {t('music.duration_label')}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <div className="flex items-center rounded-md border border-border/50 bg-muted/30 p-0.5 text-[10px]">
                            <button
                              type="button"
                              onClick={() => setDurationMode('custom')}
                              className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                                durationMode === 'custom'
                                  ? 'bg-background text-foreground shadow-xs'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {t('music.duration_custom')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDurationMode('auto')}
                              className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                                durationMode === 'auto'
                                  ? 'bg-primary text-primary-foreground shadow-xs'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {t('music.duration_auto')}
                            </button>
                          </div>
                          <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary">
                            {durationMode === 'auto'
                              ? t('music.duration_auto')
                              : Number(duration || '30') >= 60
                                ? `${formatSeconds(Number(duration || '30'))} (${duration || '30'}s)`
                                : `${duration || '30'}s`}
                          </span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="300"
                        step="5"
                        value={Number(duration) || 30}
                        onChange={(e) => {
                          setDurationMode('custom');
                          setDuration(e.target.value);
                        }}
                        disabled={durationMode === 'auto'}
                        className="h-1.5 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-45"
                        aria-label={t('music.duration_label')}
                      />
                      <div className="flex flex-wrap gap-1">
                        {(['15', '30', '60', '90', '120', '180', '240', '300'] as const).map((presetSec) => (
                          <button
                            key={presetSec}
                            type="button"
                            onClick={() => {
                              setDurationMode('custom');
                              setDuration(presetSec);
                            }}
                            className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors ${
                              durationMode === 'custom' && (duration || '30') === presetSec
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-border/60 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground'
                            }`}
                          >
                            {Number(presetSec) >= 120
                              ? `${Number(presetSec) / 60}m`
                              : `${presetSec}s`}
                          </button>
                        ))}
                      </div>
                      {durationMode === 'custom' && Number(duration || '30') > 115 && longFormCoherence && (
                        <p className="rounded border border-primary/25 bg-primary/5 px-2 py-1 text-[10px] leading-snug text-primary/90">
                          {t('music.long_form_active_hint')}
                        </p>
                      )}
                    </div>

                    {/* Lyrics (when vocal) or Instrumental Banner */}
                    {vocalMode === 'instrumental' ? (
                      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
                        <VolumeXIcon className="size-4 shrink-0 text-primary" />
                        <span>{t('music.instrumental_active_hint')}</span>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-xs font-semibold text-foreground">
                            {t('music.lyrics_label')}
                          </label>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-7 shrink-0 px-2.5 text-[11px]"
                            disabled={enhancingLyrics || !status?.healthy}
                            onClick={() => void handleEnhanceLyrics()}
                          >
                            {enhancingLyrics ? (
                              <>
                                <Loader2Icon className="mr-1 size-3 animate-spin" />
                                {t('music.enhancing_lyrics')} {formatSeconds(opElapsed)}
                              </>
                            ) : (
                              <>
                                <SparklesIcon className="mr-1 size-3" />
                                {t('music.enhance_lyrics')}
                              </>
                            )}
                          </Button>
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="mr-1 text-[10px] font-medium text-muted-foreground">
                            {t('music.lyric_tags_label')}:
                          </span>
                          {LYRIC_TAGS.map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={() =>
                                setLyrics((prev) =>
                                  prev.trim() ? `${prev.trimEnd()}\n\n${tag}\n` : `${tag}\n`,
                                )
                              }
                              className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                        <textarea
                          value={lyrics}
                          onChange={(e) => setLyrics(e.target.value)}
                          rows={5}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </div>
                    )}
                  </>
                )}

                {leftTab === 'base' && (
                  <div className="space-y-3">
                    <div className="space-y-2 rounded-xl border border-border/50 bg-background/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <label className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          <UploadIcon className="size-3.5 text-primary" />
                          {t('music.source_audio_label')}
                        </label>
                        {srcAudioPath && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                            onClick={resetBaseAudioContext}
                          >
                            <Trash2Icon className="mr-1 size-3" />
                            {t('music.delete_track')}
                          </Button>
                        )}
                      </div>

                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) void handleUploadSource(f, 'source');
                        }}
                      />

                      <div className="flex items-center gap-2">
                        <Input
                          value={srcAudioPath}
                          onChange={(e) => setSrcAudioPath(e.target.value)}
                          placeholder={t('music.base_audio_placeholder')}
                          className="h-8 min-w-0 flex-1 text-xs"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 shrink-0 px-3 text-xs"
                          disabled={uploading}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <UploadIcon className="mr-1.5 size-3.5" />
                          {uploading ? t('music.uploading') : t('music.upload_audio')}
                        </Button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{t('music.clone_hint')}</p>

                      {srcAudioPreviewUrl && (
                        <div className="space-y-1.5 rounded-lg border border-border/40 bg-muted/20 p-2">
                          <span className="text-[11px] font-medium text-muted-foreground">
                            {t('music.uploaded_preview')}
                          </span>
                          <WaveformPlayer src={apiPath(srcAudioPreviewUrl)} />
                        </div>
                      )}

                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-8 w-full text-xs"
                        disabled={analyzing || !srcAudioPath.trim()}
                        onClick={() => void handleAnalyzeSong()}
                      >
                        {analyzing ? (
                          <>
                            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                            {t('music.analyzing_song')} {formatSeconds(opElapsed)} / ~0:20
                          </>
                        ) : (
                          <>
                            <ScanSearchIcon className="mr-1.5 size-3.5" />
                            {t('music.analyze_song')}
                          </>
                        )}
                      </Button>
                    </div>

                    <div className="space-y-2.5 rounded-xl border border-border/50 bg-background/40 p-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-foreground">
                          {t('music.reference_audio_label')}
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            value={referenceAudioPath}
                            onChange={(e) => setReferenceAudioPath(e.target.value)}
                            placeholder="C:\..."
                            className="h-8 min-w-0 flex-1 text-xs"
                          />
                          {referenceAudioPath && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setReferenceAudioPath('')}
                              title={t('music.delete_track')}
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          )}
                          <input
                            ref={refFileInputRef}
                            type="file"
                            accept="audio/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              e.target.value = '';
                              if (f) void handleUploadSource(f, 'reference');
                            }}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 shrink-0 px-2.5 text-xs"
                            disabled={uploading}
                            onClick={() => refFileInputRef.current?.click()}
                          >
                            <UploadIcon className="mr-1 size-3.5" />
                            {t('music.upload_audio')}
                          </Button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-muted-foreground">
                            {t('music.cover_strength_label')}
                          </label>
                          <Input
                            type="number"
                            step="0.05"
                            min="0"
                            max="1"
                            className="h-8 text-xs"
                            value={coverStrength}
                            onChange={(e) => setCoverStrength(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-muted-foreground">
                            {t('music.cover_noise_label')}
                          </label>
                          <Input
                            type="number"
                            step="0.05"
                            min="0"
                            max="1"
                            className="h-8 text-xs"
                            value={coverNoiseStrength}
                            onChange={(e) => setCoverNoiseStrength(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-muted-foreground">
                            {t('music.repaint_start_label')}
                          </label>
                          <Input
                            type="number"
                            step="1"
                            min="0"
                            className="h-8 text-xs"
                            value={repaintStart}
                            onChange={(e) => setRepaintStart(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-muted-foreground">
                            {t('music.repaint_end_label')}
                          </label>
                          <Input
                            type="number"
                            step="1"
                            min="0"
                            className="h-8 text-xs"
                            value={repaintEnd}
                            onChange={(e) => setRepaintEnd(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {leftTab === 'advanced' && (
                  <div className="space-y-3.5">
                    {/* Saved Music Personas */}
                    <div className="space-y-1.5 rounded-xl border border-border/50 bg-background/40 p-3">
                      <span className="text-xs font-semibold text-foreground">
                        {t('music.personas_title')}
                      </span>
                      {personas.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          {t('music.no_personas')}
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {personas.map((p) => (
                            <div
                              key={p.id}
                              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5"
                            >
                              <button
                                type="button"
                                className="text-xs hover:text-primary hover:underline"
                                onClick={() => {
                                  setPrompt(p.prompt);
                                  setBpm(p.bpm);
                                  setVocalLanguage(p.vocalLanguage);
                                  setReferenceAudioPath(p.referenceAudioPath);
                                  setStudioMode('clone');
                                  setTaskType('cover');
                                  setLeftTab('create');
                                }}
                              >
                                {p.name}
                              </button>
                              <button
                                type="button"
                                className="text-[10px] text-muted-foreground hover:text-destructive"
                                onClick={() =>
                                  setPersonas((prev) => prev.filter((x) => x.id !== p.id))
                                }
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3 rounded-xl border border-border/50 bg-background/40 p-3">
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t('music.model_label')}
                        </label>
                        <SearchableSelect
                          value={model}
                          onChange={handleModelChange}
                          options={MODEL_OPTIONS}
                          ariaLabel={t('music.model_label')}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t('music.vocal_language_label')}
                        </label>
                        <SearchableSelect
                          value={vocalLanguage}
                          onChange={setVocalLanguage}
                          options={LANGUAGE_OPTIONS}
                          ariaLabel={t('music.vocal_language_label')}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t('music.format_label')}
                        </label>
                        <SearchableSelect
                          value={audioFormat}
                          onChange={(v: string) => setAudioFormat(v as 'mp3' | 'wav' | 'flac')}
                          options={FORMAT_OPTIONS}
                          ariaLabel={t('music.format_label')}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t('music.bpm_label')}
                        </label>
                        <Input
                          type="number"
                          min="30"
                          max="260"
                          className="h-9 text-xs"
                          value={bpm}
                          onChange={(e) => setBpm(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t('music.duration_label')}
                        </label>
                        <Input
                          type="number"
                          min="10"
                          max="360"
                          disabled={durationMode === 'auto'}
                          className="h-9 text-xs disabled:cursor-not-allowed disabled:opacity-45"
                          value={duration}
                          onChange={(e) => {
                            setDurationMode('custom');
                            setDuration(e.target.value);
                          }}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t('music.seed_label')}
                        </label>
                        <Input
                          type="number"
                          className="h-9 text-xs"
                          value={seed}
                          onChange={(e) => setSeed(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t('music.steps_label')}
                        </label>
                        <Input
                          type="number"
                          min="1"
                          max="100"
                          className="h-9 text-xs"
                          value={inferenceSteps}
                          onChange={(e) => setInferenceSteps(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t('music.guidance_label')}
                        </label>
                        <Input
                          type="number"
                          step="0.5"
                          min="1"
                          max="20"
                          className="h-9 text-xs"
                          value={guidanceScale}
                          onChange={(e) => setGuidanceScale(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="space-y-2 rounded-xl border border-border/50 bg-background/40 p-3 text-xs text-muted-foreground">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={thinking}
                          onChange={(e) => setThinking(e.target.checked)}
                        />
                        {t('music.thinking_label')}
                      </label>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={longFormCoherence}
                          onChange={(e) => setLongFormCoherence(e.target.checked)}
                        />
                        {t('music.long_form_coherence_label')}
                      </label>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={useFormat}
                          onChange={(e) => setUseFormat(e.target.checked)}
                        />
                        {t('music.auto_format_label')}
                      </label>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={unloadVram}
                          onChange={(e) => setUnloadVram(e.target.checked)}
                        />
                        {t('music.unload_vram_label')}
                      </label>
                    </div>

                    {/* Studio Advanced Expression & Style Controls (correct Avançado tab) */}
                    <div className="space-y-2.5 rounded-xl border border-border/50 bg-background/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          <SlidersHorizontalIcon className="size-3.5 text-primary" />
                          <span>{t('music.advanced_studio_controls_title')}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setExcludeStyles('');
                            setVocalGender('auto');
                            setDurationMode('custom');
                            setMaxMode(false);
                            setWeirdness(50);
                            setStyleInfluence(50);
                            setVariety(50);
                            setUsePersonalize(true);
                          }}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <RotateCcwIcon className="size-3" />
                          {t('music.reset_controls')}
                        </button>
                      </div>

                      {/* Exclude Styles */}
                      <div className="space-y-1 rounded-lg border border-border/40 bg-background/60 p-2">
                        <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                          <VolumeXIcon className="size-3 shrink-0" />
                          <span>{t('music.exclude_styles_label')}</span>
                        </label>
                        <Input
                          value={excludeStyles}
                          onChange={(e) => setExcludeStyles(e.target.value)}
                          placeholder={t('music.exclude_styles_placeholder')}
                          className="h-8 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
                        />
                      </div>

                      {/* Vocal Gender */}
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
                        <span className="text-xs font-medium text-foreground">
                          {t('music.vocal_gender_label')}
                        </span>
                        <div className="flex items-center gap-1">
                          {(
                            [
                              { id: 'auto', label: t('music.gender_auto') },
                              { id: 'male', label: t('music.gender_male') },
                              { id: 'female', label: t('music.gender_female') },
                            ] as const
                          ).map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              disabled={vocalMode === 'instrumental'}
                              onClick={() =>
                                setVocalGender((prev) =>
                                  opt.id !== 'auto' && prev === opt.id ? 'auto' : opt.id,
                                )
                              }
                              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                                vocalGender === opt.id
                                  ? 'border-primary bg-primary/15 text-primary'
                                  : 'border-transparent bg-muted/40 text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Duration Mode (Custom vs Auto) */}
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
                        <span className="text-xs font-medium text-foreground">
                          {t('music.duration_label')}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setDurationMode('custom')}
                            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                              durationMode === 'custom'
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-transparent bg-muted/40 text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.duration_custom')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDurationMode('auto')}
                            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                              durationMode === 'auto'
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-transparent bg-muted/40 text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.duration_auto')}
                          </button>
                        </div>
                      </div>

                      {/* Max Mode */}
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
                        <span className="text-xs font-medium text-foreground">
                          {t('music.max_mode_label')}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setMaxMode(false)}
                            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                              !maxMode
                                ? 'border-border bg-muted text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.toggle_off')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setMaxMode(true)}
                            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                              maxMode
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.toggle_on')}
                          </button>
                        </div>
                      </div>

                      {/* Weirdness */}
                      <div className="space-y-1.5 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-xs font-medium text-foreground">
                            {t('music.weirdness_label')}
                          </label>
                          <span className="font-mono text-[11px] font-semibold text-primary">
                            {weirdness}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={weirdness}
                          onChange={(e) => setWeirdness(Number(e.target.value))}
                          className="h-1.5 w-full cursor-pointer accent-primary"
                          aria-label={t('music.weirdness_label')}
                        />
                      </div>

                      {/* Style Influence */}
                      <div className="space-y-1.5 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-xs font-medium text-foreground">
                            {t('music.style_influence_label')}
                          </label>
                          <span className="font-mono text-[11px] font-semibold text-primary">
                            {styleInfluence}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={styleInfluence}
                          onChange={(e) => setStyleInfluence(Number(e.target.value))}
                          className="h-1.5 w-full cursor-pointer accent-primary"
                          aria-label={t('music.style_influence_label')}
                        />
                      </div>

                      {/* Variety */}
                      <div className="space-y-1.5 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <label className="text-xs font-medium text-foreground">
                              {t('music.variety_label')}
                            </label>
                            <button
                              type="button"
                              onClick={() => setVariety(50)}
                              className="text-muted-foreground hover:text-foreground"
                              title={t('music.reset_controls')}
                            >
                              <RotateCcwIcon className="size-3" />
                            </button>
                          </div>
                          <span className="font-mono text-[11px] font-semibold text-primary">
                            {variety >= 70
                              ? t('music.variety_extra')
                              : variety <= 25
                                ? t('music.variety_steady')
                                : `${variety}%`}
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={variety}
                          onChange={(e) => setVariety(Number(e.target.value))}
                          className="h-1.5 w-full cursor-pointer accent-primary"
                          aria-label={t('music.variety_label')}
                        />
                      </div>

                      {/* Personalize (My taste) */}
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-foreground">
                            {t('music.personalize_label')}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {t('music.personalize_my_taste')}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setUsePersonalize(false)}
                            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                              !usePersonalize
                                ? 'border-border bg-muted text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.toggle_off')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setUsePersonalize(true)}
                            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                              usePersonalize
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('music.toggle_on')}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="shrink-0 space-y-2.5 border-t border-border/60 bg-card/95 p-3.5 backdrop-blur">
                {/* Organized Pre-Creation Metadata Summary */}
                <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/50 bg-background/50 px-2.5 py-2 text-[10px]">
                  <span className="font-semibold text-muted-foreground">
                    {t('music.pre_metadata_label')}:
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                    {vocalMode === 'instrumental'
                      ? t('music.vocal_mode_instrumental')
                      : t('music.vocal_mode_singing')}
                  </span>
                  {vocalMode === 'vocal' && vocalGender !== 'auto' && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary">
                      {vocalGender === 'male' ? t('music.gender_male') : t('music.gender_female')}
                    </span>
                  )}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
                    {model.replace('acestep-', '')}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 uppercase text-muted-foreground">
                    {vocalLanguage}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {bpm || '120'} BPM
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {durationMode === 'auto' ? t('music.duration_auto') : `${duration || '30'}s`}
                  </span>
                  {maxMode && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">
                      Max
                    </span>
                  )}
                  <span className="rounded bg-muted px-1.5 py-0.5 uppercase text-muted-foreground">
                    {audioFormat}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {inferenceSteps || '8'} steps · CFG {guidanceScale || '7.0'}
                  </span>
                </div>

                {(prefStats.likes_count > 0 || prefStats.dislikes_count > 0) && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-[10px]">
                    <div className="flex items-center gap-1.5 text-foreground">
                      <SparklesIcon className="size-3 shrink-0 text-primary" />
                      <span className="font-semibold">{t('music.adaptive_ai_label')}</span>
                      <span className="text-muted-foreground">
                        {prefStats.likes_count} 👍 · {prefStats.dislikes_count} 👎
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await apiFetch('/api/music/preferences', { method: 'DELETE' });
                          setPrefStats({ likes_count: 0, dislikes_count: 0 });
                        } catch {
                          // ignore
                        }
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-background/80 hover:text-foreground"
                    >
                      {t('music.adaptive_ai_reset')}
                    </button>
                  </div>
                )}

                <JobProgressBanner
                  active={generating || anyOpBusy}
                  label={generating ? t('music.generating') : activeOpLabel}
                  stage={generating ? genStage : undefined}
                  elapsedSec={generating ? genElapsed : opElapsed}
                  estimatedSec={generating ? genEstimateSec : activeOpEstimateSec}
                  doneNotice={doneNotice}
                />

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {doneNotice && !generating && !anyOpBusy ? (
                      <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2Icon className="size-3.5" />
                        {t('music.done_in', { time: formatSeconds(doneNotice.elapsedSec) })}
                      </span>
                    ) : taskStatus ? (
                      `${t('music.status_prefix')}: ${taskStatus}`
                    ) : (
                      t('music.ready')
                    )}
                  </span>
                  <Button
                    type="submit"
                    className="relative overflow-hidden"
                    disabled={generating || !status?.healthy}
                  >
                    {generating ? (
                      <>
                        <Loader2Icon className="mr-2 size-4 animate-spin" />
                        {t('music.generating')} {formatSeconds(genElapsed)} / ~
                        {formatSeconds(genEstimateSec)}
                        <span
                          className="absolute bottom-0 left-0 h-1 bg-primary-foreground/75 transition-all duration-500"
                          style={{ width: `${computeProgressPct(genElapsed, genEstimateSec)}%` }}
                        />
                      </>
                    ) : (
                      <>
                        <SparklesIcon className="mr-2 size-4" />
                        {t('music.generate')}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </form>
          </div>

          <div className="flex min-h-0 flex-col gap-3">
            {/* Right column tab switcher */}
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-border/60 bg-card p-1.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setRightTab('tracks')}
                  className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${rightTab === 'tracks'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                >
                  <MusicIcon className="size-3.5" />
                  <span>{t('music.results_title')}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold ${rightTab === 'tracks'
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-muted text-foreground'
                      }`}
                  >
                    {tracks.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab('mixer')}
                  className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${rightTab === 'mixer'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                >
                  <LayersIcon className="size-3.5" />
                  <span>{t('music.mixer_title')}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold ${rightTab === 'mixer'
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-muted text-foreground'
                      }`}
                    >
                      {mixerTracks.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightTab('studio')}
                    className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      rightTab === 'studio'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <SlidersHorizontalIcon className="size-3.5" />
                    <span>{t('music.studio_tab')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRightTab('trash');
                      void syncTrashFromDisk();
                    }}
                    className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      rightTab === 'trash'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                  <Trash2Icon className="size-3.5" />
                  <span>{t('music.trash_title')}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold ${rightTab === 'trash'
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-muted text-foreground'
                      }`}
                  >
                    {trashTracks.length}
                  </span>
                </button>
              </div>

              <div className="flex items-center gap-1">
                {rightTab === 'trash' && trashTracks.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => void handleEmptyTrash()}
                    title={t('music.empty_trash')}
                  >
                    <Trash2Icon className="mr-1.5 size-3.5" />
                    {t('music.empty_trash')}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={syncingLibrary}
                  onClick={() => {
                    void syncLibraryFromDisk();
                    void syncTrashFromDisk();
                  }}
                  title={t('music.refresh_library')}
                >
                  <RefreshCwIcon
                    className={`mr-1 size-3.5 ${syncingLibrary ? 'animate-spin' : ''}`}
                  />
                  {t('music.refresh_library')}
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {rightTab === 'tracks' ? (
                <div className="space-y-4">
                  {(generating || anyOpBusy || doneNotice) && (
                    <JobProgressBanner
                      active={generating || anyOpBusy}
                      label={generating ? t('music.generating') : activeOpLabel}
                      stage={generating ? genStage : undefined}
                      elapsedSec={generating ? genElapsed : opElapsed}
                      estimatedSec={generating ? genEstimateSec : activeOpEstimateSec}
                      doneNotice={doneNotice}
                    />
                  )}

                  {jobHistory.length > 0 && (
                    <div className="space-y-1.5 rounded-xl border border-border/50 bg-card/70 p-3">
                      <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                        <span>{t('music.activity_log_title')}</span>
                      </div>
                      <div className="space-y-1">
                        {jobHistory.map((job) => (
                          <div
                            key={job.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background/60 px-2.5 py-1.5 text-xs"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {job.status === 'running' ? (
                                <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
                              ) : job.status === 'succeeded' ? (
                                <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />
                              ) : (
                                <AlertCircleIcon className="size-3.5 shrink-0 text-destructive" />
                              )}
                              <span className="truncate font-medium">{job.label}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {job.timeStr}
                              </span>
                            </div>
                            <span
                              className={`text-[11px] font-medium ${job.status === 'succeeded'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : job.status === 'failed'
                                  ? 'text-destructive'
                                  : 'text-primary'
                                }`}
                            >
                              {job.status === 'running'
                                ? t('music.stage_running')
                                : job.status === 'succeeded'
                                  ? `${t('music.job_generated_ok', { count: job.tracksCount ?? 1 })}${job.elapsedSec ? ` • ${formatSeconds(job.elapsedSec)}` : ''}`
                                  : job.error || t('music.job_failed')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {tracks.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setTrackFilter('all')}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${trackFilter === 'all'
                            ? 'bg-primary text-primary-foreground'
                            : 'border border-border/60 bg-card text-muted-foreground hover:text-foreground'
                            }`}
                        >
                          {t('music.filter_all')} ({tracks.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setTrackFilter('liked')}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${trackFilter === 'liked'
                            ? 'bg-emerald-600 text-white'
                            : 'border border-border/60 bg-card text-muted-foreground hover:text-foreground'
                            }`}
                        >
                          <ThumbsUpIcon className="size-3" />
                          <span>
                            {t('music.filter_liked')} (
                            {tracks.filter((tr) => tr.rating === 'like').length})
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setTrackFilter('new')}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${trackFilter === 'new'
                            ? 'bg-primary text-primary-foreground'
                            : 'border border-border/60 bg-card text-muted-foreground hover:text-foreground'
                            }`}
                        >
                          {t('music.badge_new')} (
                          {tracks.filter((tr) => tr.listened === false).length})
                        </button>
                      </div>
                      <div className="relative w-full sm:w-56">
                        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder={t('music.search_tracks_placeholder')}
                          className="h-8 pl-8 pr-7 text-xs"
                        />
                        {searchQuery && (
                          <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                            aria-label={t('music.clear_filters')}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                    {tracks.length === 0 ? (
                      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/50 px-6 py-16 text-center">
                        <MusicIcon className="mb-3 size-9 text-muted-foreground/60" />
                        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                          {t('music.empty_tracks')}
                        </p>
                      </div>
                    ) : (() => {
                      const filteredTracks = tracks.filter((tr) => {
                        if (trackFilter === 'liked' && tr.rating !== 'like') return false;
                        if (trackFilter === 'new' && tr.listened !== false) return false;
                        const q = searchQuery.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          (tr.title || '').toLowerCase().includes(q) ||
                          (tr.prompt || '').toLowerCase().includes(q) ||
                          (tr.lyrics || '').toLowerCase().includes(q) ||
                          (tr.model || '').toLowerCase().includes(q) ||
                          String(tr.bpm || '').includes(q)
                        );
                      });
                      if (filteredTracks.length === 0) {
                        return (
                          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/60 bg-card/50 px-6 py-12 text-center">
                            <SearchIcon className="size-7 text-muted-foreground/60" />
                            <p className="text-xs text-muted-foreground">
                              {t('music.no_matching_tracks')}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-3 text-xs"
                              onClick={() => {
                                setTrackFilter('all');
                                setSearchQuery('');
                              }}
                            >
                              {t('music.clear_filters')}
                            </Button>
                          </div>
                        );
                      }
                      return (
                        <div className="space-y-4">
                          {filteredTracks.map((track) => (
                            <TrackCard
                              key={track.id}
                              track={track}
                              isLatest={track.id === latestTrackId}
                              separating={separatingUrl === track.url}
                              separatingMode={separatingUrl === track.url ? separatingMode : null}
                              opElapsed={opElapsed}
                              creatingProfile={creatingProfileId === track.id}
                              editing={editingTrackId === track.id}
                              remastering={remasteringTrackId === track.id}
                              sidecarHealthy={Boolean(status?.healthy)}
                              onDelete={() => void handleDeleteTrack(track)}
                              onRegenerate={() => void handleRegenerate(track)}
                              onRemix={() => void handleRemix(track)}
                              onExtend={() => void handleExtendTrack(track)}
                              onRemaster={() => void handleRemasterTrack(track)}
                              onSavePersona={() => void handleSavePersona(track)}
                              onSendToMixer={handleSendToMixer}
                              onUseAsCover={() => void handleUseAsCover(track)}
                              onRepaintSection={(s, e) => void handleRepaintSection(track, s, e)}
                              onSeparateStems={(mode) => void handleSeparateStems(track, mode)}
                              onCreateVoiceProfile={() => void handleCreateVoiceProfile(track)}
                              onApplyEdit={(params) => void handleApplyEdit(track, params)}
                              onRate={(rating) => void handleRateTrack(track, rating)}
                              onUpdateMetadata={(patch) => handleUpdateTrackMetadata(track, patch)}
                              onMarkListened={() => void handleMarkListened(track)}
                              onCloneTrack={() => void handleCloneTrack(track)}
                              onOpenInStudio={() => handleOpenInStudio(track)}
                            />
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                ) : rightTab === 'studio' ? (
                  (() => {
                    const activeStudioTrack =
                      tracks.find((tr) => tr.id === studioTrackId) || tracks[0] || null;
                    if (!activeStudioTrack) {
                      return (
                        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/50 px-6 py-16 text-center">
                          <SlidersHorizontalIcon className="mb-3 size-8 text-muted-foreground/60" />
                          <p className="text-xs text-muted-foreground">
                            {t('music.studio_empty')}
                          </p>
                        </div>
                      );
                    }
                    return (
                      <div className="space-y-4">
                        <div className="space-y-3 rounded-xl border border-border/60 bg-card p-3.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                className="shrink-0"
                                onClick={() => setRightTab('tracks')}
                                title={t('music.results_title')}
                                aria-label={t('music.results_title')}
                              >
                                <ArrowLeftIcon className="size-4" />
                              </Button>
                              <div className="min-w-0 flex-1">
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                  {t('music.studio_editing_label')}
                                </div>
                                <div className="truncate text-sm font-semibold text-foreground">
                                  {activeStudioTrack.title || activeStudioTrack.prompt}
                                </div>
                              </div>
                            </div>
                            {tracks.length > 1 && (
                              <div className="w-56">
                                <SearchableSelect
                                  value={activeStudioTrack.id}
                                  onChange={(val: string) => setStudioTrackId(val)}
                                  options={tracks.map((tr) => ({
                                    value: tr.id,
                                    label: tr.title || tr.prompt.slice(0, 40) || tr.id,
                                  }))}
                                  ariaLabel={t('music.studio_editing_label')}
                                />
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-2.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => void handleCloneTrack(activeStudioTrack)}
                            >
                              <CopyIcon className="mr-1.5 size-3.5" />
                              {t('music.clone_track')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              disabled={remasteringTrackId === activeStudioTrack.id}
                              onClick={() => void handleRemasterTrack(activeStudioTrack)}
                            >
                              <Wand2Icon className="mr-1.5 size-3.5" />
                              {t('music.remaster')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              disabled={separatingUrl === activeStudioTrack.url}
                              onClick={() => void handleSeparateStems(activeStudioTrack, '2stems')}
                            >
                              <ScissorsIcon className="mr-1.5 size-3.5" />
                              {t('music.separate_stems')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              disabled={separatingUrl === activeStudioTrack.url}
                              onClick={() => void handleSeparateStems(activeStudioTrack, '4stems')}
                            >
                              <ScissorsIcon className="mr-1.5 size-3.5" />
                              {t('music.separate_4stems')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              onClick={() =>
                                handleSendToMixer(
                                  activeStudioTrack.title ||
                                    activeStudioTrack.prompt.slice(0, 28) ||
                                    activeStudioTrack.id,
                                  activeStudioTrack.url,
                                )
                              }
                            >
                              <LayersIcon className="mr-1.5 size-3.5" />
                              {t('music.send_to_mixer')}
                            </Button>
                          </div>
                        </div>
                        <TrackCard
                          key={`studio-${activeStudioTrack.id}`}
                          track={activeStudioTrack}
                          isLatest={false}
                          separating={separatingUrl === activeStudioTrack.url}
                          separatingMode={
                            separatingUrl === activeStudioTrack.url ? separatingMode : null
                          }
                          opElapsed={opElapsed}
                          creatingProfile={creatingProfileId === activeStudioTrack.id}
                          editing={editingTrackId === activeStudioTrack.id}
                          remastering={remasteringTrackId === activeStudioTrack.id}
                          sidecarHealthy={Boolean(status?.healthy)}
                          onDelete={() => void handleDeleteTrack(activeStudioTrack)}
                          onRegenerate={() => void handleRegenerate(activeStudioTrack)}
                          onRemix={() => void handleRemix(activeStudioTrack)}
                          onExtend={() => void handleExtendTrack(activeStudioTrack)}
                          onRemaster={() => void handleRemasterTrack(activeStudioTrack)}
                          onSavePersona={() => void handleSavePersona(activeStudioTrack)}
                          onSendToMixer={handleSendToMixer}
                          onUseAsCover={() => void handleUseAsCover(activeStudioTrack)}
                          onRepaintSection={(s, e) =>
                            void handleRepaintSection(activeStudioTrack, s, e)
                          }
                          onSeparateStems={(mode) =>
                            void handleSeparateStems(activeStudioTrack, mode)
                          }
                          onCreateVoiceProfile={() =>
                            void handleCreateVoiceProfile(activeStudioTrack)
                          }
                          onApplyEdit={(params) => void handleApplyEdit(activeStudioTrack, params)}
                          onRate={(rating) => void handleRateTrack(activeStudioTrack, rating)}
                          onUpdateMetadata={(patch) =>
                            handleUpdateTrackMetadata(activeStudioTrack, patch)
                          }
                          onMarkListened={() => void handleMarkListened(activeStudioTrack)}
                          onCloneTrack={() => void handleCloneTrack(activeStudioTrack)}
                          onOpenInStudio={() => handleOpenInStudio(activeStudioTrack)}
                        />
                      </div>
                    );
                  })()
                ) : rightTab === 'mixer' ? (
                  <MultitrackMixer
                    tracks={mixerTracks}
                    mixing={mixing}
                    opElapsed={opElapsed}
                    onUpdateTrack={(id, patch) =>
                      setMixerTracks((prev) =>
                        prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
                      )
                    }
                    onRemoveTrack={(id) =>
                      setMixerTracks((prev) => prev.filter((item) => item.id !== id))
                    }
                    onClear={() => setMixerTracks([])}
                    onMix={() => void handleMixMultitrack()}
                  />
                ) : (
                  <div className="space-y-3">
                    {trashTracks.length === 0 ? (
                      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/50 px-6 py-16 text-center">
                        <Trash2Icon className="mb-3 size-8 text-muted-foreground/60" />
                        <p className="text-xs text-muted-foreground">{t('music.trash_empty')}</p>
                      </div>
                    ) : (
                      trashTracks.map((item) => (
                        <div
                          key={item.id}
                          className="space-y-2.5 rounded-xl border border-border/50 bg-background/60 p-4"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                                  {item.format}
                                </span>
                                {item.bpm && (
                                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {item.bpm} BPM
                                  </span>
                                )}
                                {item.duration && (
                                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {item.duration}s
                                  </span>
                                )}
                                <span className="truncate text-xs font-medium text-foreground">
                                  {item.title || item.filename}
                                </span>
                              </div>
                              {item.prompt && (
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {item.prompt}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2.5 text-xs"
                                onClick={() => void handleRestoreTrack(item)}
                              >
                                <RotateCcwIcon className="mr-1.5 size-3.5" />
                                {t('music.restore_track')}
                              </Button>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="destructive"
                                className="h-7 w-7"
                                onClick={() => void handleDeleteTrashItem(item)}
                                title={t('music.delete_permanently')}
                                aria-label={t('music.delete_permanently')}
                              >
                                <Trash2Icon className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        <WaveformPlayer src={apiPath(item.url)} />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
