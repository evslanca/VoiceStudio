import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  AudioLinesIcon,
  BookOpenIcon,
  Disc3Icon,
  FilmIcon,
  FolderOpenIcon,
  MusicIcon,
  SettingsIcon,
  SparklesIcon,
  UsersRoundIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './home-page.css';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import { appVersion } from '@/components/bridge';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import {
  readDraft,
  replaceRecipe,
  restoreDesignProfile,
  writeDraft,
} from '@/features/design/design-draft';
import { openDubProject } from '@/features/dub/dub-session';
import { blankLongformDraft, editLongform } from '@/features/longform/longform-session';
import { projectLibrary, type LongformProject } from '@/features/longform/project-library';
import type { DubProject } from '@/features/projects/project-format';
import { useProfiles } from '@/hooks/use-profiles';
import { apiJson } from '@/lib/api/client';
import { brandArtwork, brandIcon } from '@/lib/brand';
import { patchCloneSettings } from '@/lib/store/clone-settings';
import { selectCloneProfile } from '@/lib/store/reference';
import { HomeFeatureIcon } from './home-feature-icon';
import { PixelSnow, currentHomeSeason } from './home-season';

interface Destination {
  to: string;
  label: string;
  description: string;
}

interface ExportRecord {
  id: string;
  filename: string;
  destination_path: string;
  mode?: string;
}

interface HomeMusicStatus {
  installed: boolean;
  running: boolean;
  healthy: boolean;
  loaded_model?: string | null;
}

interface HomeMusicTrack {
  id: string;
  url: string;
  title?: string | null;
  prompt: string;
  filename?: string;
  bpm?: number | null;
  duration?: number | null;
  vocal_language?: string;
  vocal_mode?: 'vocal' | 'instrumental';
}

const iconTones: Record<string, string> = {
  '/music':
    'bg-pink-100 text-pink-700 ring-pink-300/60 dark:bg-pink-400/15 dark:text-pink-300 dark:ring-pink-300/30',
  '/clone':
    'bg-sky-100 text-sky-700 ring-sky-300/60 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-300/30',
  '/design':
    'bg-violet-100 text-violet-700 ring-violet-300/60 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-300/30',
  '/dub':
    'bg-teal-100 text-teal-700 ring-teal-300/60 dark:bg-teal-400/15 dark:text-teal-300 dark:ring-teal-300/30',
  '/stories':
    'bg-rose-100 text-rose-700 ring-rose-300/60 dark:bg-rose-400/15 dark:text-rose-300 dark:ring-rose-300/30',
  '/audiobook':
    'bg-amber-100 text-amber-800 ring-amber-300/60 dark:bg-amber-400/15 dark:text-amber-200 dark:ring-amber-300/30',
  '/batch':
    'bg-emerald-100 text-emerald-700 ring-emerald-300/60 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-300/30',
  '/transcriptions':
    'bg-cyan-100 text-cyan-700 ring-cyan-300/60 dark:bg-cyan-400/15 dark:text-cyan-200 dark:ring-cyan-300/30',
  '/personas':
    'bg-orange-100 text-orange-700 ring-orange-300/60 dark:bg-orange-400/15 dark:text-orange-300 dark:ring-orange-300/30',
  '/gallery':
    'bg-fuchsia-100 text-fuchsia-700 ring-fuchsia-300/60 dark:bg-fuchsia-400/15 dark:text-fuchsia-300 dark:ring-fuchsia-300/30',
  '/workflows':
    'bg-indigo-100 text-indigo-700 ring-indigo-300/60 dark:bg-indigo-400/15 dark:text-indigo-300 dark:ring-indigo-300/30',
  '/tools':
    'bg-slate-100 text-slate-700 ring-slate-300/60 dark:bg-slate-300/15 dark:text-slate-200 dark:ring-slate-300/30',
  '/integrations':
    'bg-blue-100 text-blue-700 ring-blue-300/60 dark:bg-blue-400/15 dark:text-blue-300 dark:ring-blue-300/30',
};

function formatTrackDuration(seconds?: number | null): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const version = appVersion();
  const season = currentHomeSeason();
  const { data: profilesData = [] } = useProfiles();
  const { data: exportsData = [] } = useQuery({
    queryKey: ['export-history'],
    queryFn: ({ signal }) => apiJson<ExportRecord[]>('/export/history', { signal }),
    staleTime: 30_000,
  });
  const { data: dubProjectsData = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => apiJson<DubProject[]>('/projects', { signal }),
  });
  const { data: longformProjectsData = [] } = useQuery({
    queryKey: ['longform-projects'],
    queryFn: projectLibrary.list,
  });
  const { data: musicStatusData = null } = useQuery({
    queryKey: ['home-music-status'],
    queryFn: async ({ signal }) => {
      try {
        return await apiJson<HomeMusicStatus>('/api/music/status', { signal });
      } catch {
        return null;
      }
    },
    staleTime: 15_000,
  });
  const { data: musicLibraryData = [] } = useQuery({
    queryKey: ['home-music-library'],
    queryFn: async ({ signal }) => {
      try {
        const res = await apiJson<{ tracks?: HomeMusicTrack[] }>('/api/music/library?limit=4', {
          signal,
        });
        return Array.isArray(res?.tracks) ? res.tracks : [];
      } catch {
        return [];
      }
    },
    staleTime: 20_000,
  });

  const profiles = Array.isArray(profilesData) ? profilesData : [];
  const exports = Array.isArray(exportsData) ? exportsData : [];
  const dubProjects = Array.isArray(dubProjectsData) ? dubProjectsData : [];
  const longformProjects = Array.isArray(longformProjectsData) ? longformProjectsData : [];
  const recentTracks = Array.isArray(musicLibraryData) ? musicLibraryData.slice(0, 4) : [];
  const musicStatus =
    musicStatusData && typeof musicStatusData === 'object' && 'running' in musicStatusData
      ? musicStatusData
      : null;

  const primaryDestinations: Destination[] = [
    { to: '/music', label: t('homeUi.musicTitle'), description: t('homeUi.music') },
    { to: '/clone', label: t('nav.clone'), description: t('clone.reference_hint') },
    { to: '/design', label: t('designWorkspace.title'), description: t('homeUi.design') },
    { to: '/dub', label: t('dubWorkspace.title'), description: t('homeUi.dub') },
  ];

  const secondaryDestinations: Destination[] = [
    { to: '/stories', label: t('nav.stories'), description: t('homeUi.stories') },
    { to: '/audiobook', label: t('audiobook.title'), description: t('homeUi.audiobook') },
    { to: '/batch', label: t('nav.batch_dub'), description: t('homeUi.batch') },
    { to: '/transcriptions', label: t('nav.transcribe'), description: t('homeUi.transcribe') },
    { to: '/personas', label: t('projects.voice_profiles'), description: t('homeUi.personas') },
    { to: '/gallery', label: t('nav.gallery'), description: t('gallery.subtitle') },
    { to: '/workflows', label: t('workflows.title'), description: t('workflows.description') },
    { to: '/tools', label: t('tools.title'), description: t('tools.desc') },
    {
      to: '/integrations',
      label: t('integrationCatalog.title'),
      description: t('homeUi.integrations'),
    },
  ];

  const recentProjects = [
    ...dubProjects.map((project) => ({
      kind: 'dub' as const,
      project,
      updatedAt:
        (project.updated_at || 0) < 1e12
          ? (project.updated_at || 0) * 1000
          : project.updated_at || 0,
    })),
    ...longformProjects.map((project) => ({
      kind: 'longform' as const,
      project,
      updatedAt: project.updatedAt,
    })),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);

  const openProject = async (
    item: { kind: 'dub'; project: DubProject } | { kind: 'longform'; project: LongformProject },
  ) => {
    if (item.kind === 'dub') {
      const project = await apiJson<DubProject>('/projects/' + encodeURIComponent(item.project.id));
      if (openDubProject(project)) await navigate({ to: '/dub' });
      return;
    }
    editLongform(item.project.mode, {
      ...blankLongformDraft(),
      ...structuredClone(item.project.draft),
      projectId: item.project.id,
    });
    await navigate({
      to: item.project.mode === 'stories' ? '/stories' : '/audiobook',
    });
  };

  /** Open a saved voice in its original creation workflow and restore settings. */
  const useProfile = async (profile: (typeof profiles)[number]) => {
    if (profile.kind === 'design') {
      const current = readDraft();
      const restored = restoreDesignProfile(profile, current.seed);
      writeDraft(
        replaceRecipe(current, {
          attrs: restored.attrs,
          seed: restored.seed,
          profileId: restored.profileId,
          description: restored.description,
          picks: restored.picks,
          mapped: restored.mapped,
        }),
      );
      patchCloneSettings({ language: restored.language });
      await navigate({ to: '/design' });
      return;
    }
    selectCloneProfile(profile);
    await navigate({ to: '/clone' });
  };

  const musicStatusText = musicStatus?.running
    ? t('music.online')
    : musicStatus?.installed
      ? t('music.offline')
      : recentTracks.length > 0
        ? String(recentTracks.length)
        : t('music.not_installed');

  const musicDotClass = musicStatus?.running
    ? 'bg-emerald-500 shadow-[0_0_8px_rgb(16_185_129/65%)]'
    : musicStatus?.installed
      ? 'bg-amber-500'
      : 'bg-muted-foreground/45';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader>
        <h1 className="text-sm font-medium">{t('nav.home')}</h1>
        <Link
          to="/projects"
          className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <FolderOpenIcon className="size-4" />
          {t('projects.title')}
        </Link>
      </WorkspaceHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="home-content mx-auto w-full max-w-6xl">
          <section aria-labelledby="home-new-projects">
            <div
              className="home-heading relative isolate overflow-hidden"
              data-season={season ?? undefined}
            >
              {season && <PixelSnow />}
              <img
                src={brandArtwork}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 -z-10 h-full w-1/2 object-cover object-right opacity-25 [mask-image:linear-gradient(90deg,transparent,black)]"
              />
              <div className="home-heading-row">
                <div className="home-heading-copy">
                  <div className="flex flex-wrap items-center gap-3">
                    <img
                      src={brandIcon}
                      alt=""
                      aria-hidden="true"
                      className="size-9 rounded-xl border border-border/60 bg-card/80 p-1 shadow-sm"
                    />
                    <h2
                      id="home-new-projects"
                      className="text-3xl font-semibold tracking-[-0.035em]"
                    >
                      {t('homeUi.title')}
                    </h2>
                    {version && (
                      <span className="inline-flex items-center rounded-full border border-border/60 bg-card/70 px-2.5 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                        {t('app.version', { version })}
                      </span>
                    )}
                  </div>
                  <p className="mt-3 max-w-[72ch] text-sm leading-relaxed text-foreground/65">
                    {t('homeUi.subtitle')}
                  </p>
                  <div className="home-hero-meta">
                    <Link
                      to="/settings"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent/60 hover:text-foreground"
                    >
                      <SettingsIcon className="size-3.5" aria-hidden="true" />
                      {t('nav.settings')}
                    </Link>
                    <Link
                      to="/integrations"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent/60 hover:text-foreground"
                    >
                      <SparklesIcon className="size-3.5" aria-hidden="true" />
                      {t('integrationCatalog.title')}
                    </Link>
                  </div>
                </div>

                <div
                  className="home-overview-stats"
                  role="region"
                  aria-label={t('homeUi.overview')}
                >
                  <Link
                    to="/music"
                    className="group flex flex-col justify-between rounded-xl border border-border/60 bg-card/75 px-3.5 py-2.5 transition-colors hover:border-pink-400/40 hover:bg-card"
                  >
                    <span className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
                      <span className="truncate">{t('homeUi.musicTitle')}</span>
                      <span
                        className={`size-2 shrink-0 rounded-full ${musicDotClass}`}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="mt-1 truncate text-sm font-semibold text-foreground">
                      {musicStatusText}
                    </span>
                  </Link>

                  <Link
                    to="/personas"
                    className="group flex flex-col justify-between rounded-xl border border-border/60 bg-card/75 px-3.5 py-2.5 transition-colors hover:border-primary/40 hover:bg-card"
                  >
                    <span className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
                      <span className="truncate">{t('projects.voice_profiles')}</span>
                      <UsersRoundIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                    </span>
                    <span className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                      {profiles.length}
                    </span>
                  </Link>

                  <Link
                    to="/projects"
                    className="group flex flex-col justify-between rounded-xl border border-border/60 bg-card/75 px-3.5 py-2.5 transition-colors hover:border-primary/40 hover:bg-card"
                  >
                    <span className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
                      <span className="truncate">{t('projects.title')}</span>
                      <FolderOpenIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                    </span>
                    <span className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                      {dubProjects.length + longformProjects.length}
                    </span>
                  </Link>

                  <Link
                    to="/projects"
                    className="group flex flex-col justify-between rounded-xl border border-border/60 bg-card/75 px-3.5 py-2.5 transition-colors hover:border-primary/40 hover:bg-card"
                  >
                    <span className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
                      <span className="truncate">{t('projects.exports')}</span>
                      <Disc3Icon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                    </span>
                    <span className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                      {exports.length}
                    </span>
                  </Link>
                </div>
              </div>
            </div>

            <div className="home-destinations home-destinations--primary grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
              {primaryDestinations.map(({ to, label, description }) => (
                <Link
                  key={to}
                  to={to}
                  data-destination={to}
                  className="home-destination home-destination--primary group"
                >
                  <div
                    className={`home-destination-icon flex size-10 items-center justify-center rounded-xl ring-1 ring-inset shadow-[inset_0_1px_0_rgb(255_255_255/10%)] ${iconTones[to]}`}
                  >
                    <HomeFeatureIcon destination={to} />
                  </div>
                  <svg
                    className="home-card-art"
                    viewBox="0 0 160 72"
                    fill="none"
                    aria-hidden="true"
                  >
                    {to === '/music' ? (
                      <>
                        <path d="M12 52h136M12 38h136M12 24h136" opacity=".4" />
                        <path d="M18 46c18-24 34 8 52-18s34 14 52-12 18 16 26 4" />
                        <circle cx="92" cy="48" r="5.5" />
                        <circle cx="126" cy="40" r="5.5" />
                        <path d="M97.5 48V20l34-7v27" />
                      </>
                    ) : to === '/clone' ? (
                      <path d="M8 36h12m8-10v20m10-32v44m10-24v4m10-30v56m10-42v28m10-36v44m10-22h12m8-10v20m10-32v44m10-24v4m10-16v28m10-18h6" />
                    ) : to === '/design' ? (
                      <>
                        <path d="M8 48c24 0 24-24 48-24s24 24 48 24 24-24 48-24" />
                        <path d="M8 32c24 0 24-12 48-12s24 40 48 40 24-40 48-40" />
                        <path d="M8 58c24 0 24-42 48-42s24 22 48 22 24-22 48-22" />
                      </>
                    ) : (
                      <>
                        <rect x="15" y="12" width="88" height="31" rx="8" />
                        <rect x="57" y="31" width="88" height="31" rx="8" />
                        <path d="M29 27h12m6 0h28m-4 19h23m6 0h29" />
                      </>
                    )}
                  </svg>
                  <div className="home-destination-copy">
                    <h3>{label}</h3>
                    <p>{description}</p>
                  </div>
                  <ArrowRightIcon className="home-destination-arrow" aria-hidden="true" />
                </Link>
              ))}
            </div>

            <div className="home-destinations home-destinations--secondary grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3 @xl:[&>:last-child:nth-child(odd)]:col-span-2 @3xl:[&>:last-child:nth-child(odd)]:col-span-1">
              {secondaryDestinations.map(({ to, label, description }) => (
                <Link
                  key={to}
                  to={to}
                  data-destination={to}
                  className="home-destination home-destination--secondary group"
                >
                  <div
                    className={`home-destination-icon flex size-10 items-center justify-center rounded-xl ring-1 ring-inset shadow-[inset_0_1px_0_rgb(255_255_255/10%)] ${iconTones[to]}`}
                  >
                    <HomeFeatureIcon destination={to} />
                  </div>
                  <div className="home-destination-copy">
                    <h3>{label}</h3>
                    <p>{description}</p>
                  </div>
                  <ArrowRightIcon className="home-destination-arrow" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </section>

          {recentTracks.length > 0 && (
            <section className="mt-8">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <MusicIcon className="size-4 text-muted-foreground" />
                  {t('homeUi.recentMusic')}
                </h2>
                <Link
                  to="/music"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('common.open')}
                </Link>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-2">
                {recentTracks.map((track) => {
                  const durationLabel = formatTrackDuration(track.duration);
                  const metaParts = [
                    track.bpm ? `${Math.round(track.bpm)} BPM` : null,
                    durationLabel,
                  ].filter(Boolean);
                  return (
                    <Link
                      key={track.id || track.url}
                      to="/music"
                      className="group flex min-w-0 items-center gap-3 rounded-xl border border-border/50 bg-card/20 px-3 py-2.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <MusicIcon className="size-4 shrink-0 text-pink-400" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {track.title || track.prompt || track.filename}
                        </span>
                        {metaParts.length > 0 && (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {metaParts.join(' · ')}
                          </span>
                        )}
                      </span>
                      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {exports.length > 0 && (
            <section className="mt-8">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <FolderOpenIcon className="size-4 text-muted-foreground" />
                  {t('projects.exports')}
                </h2>
                <Link
                  to="/projects"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('projects.all')}
                </Link>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-2">
                {exports.slice(0, 4).map((record) => (
                  <Link
                    key={record.id}
                    to="/projects"
                    className="group flex min-w-0 items-center gap-3 rounded-xl border border-border/50 bg-card/20 px-3 py-2.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FolderOpenIcon className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {record.filename ||
                          record.destination_path.split(/[\\/]/).pop() ||
                          t('projects.export')}
                      </span>
                      {record.mode && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {record.mode}
                        </span>
                      )}
                    </span>
                    <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />
                  </Link>
                ))}
              </div>
            </section>
          )}

          {recentProjects.length > 0 && (
            <section className="mt-8">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <FolderOpenIcon className="size-4 text-muted-foreground" />
                  {t('projects.title')}
                </h2>
                <Link
                  to="/projects"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('projects.all')}
                </Link>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-2">
                {recentProjects.map((item) => {
                  const Icon =
                    item.kind === 'dub'
                      ? FilmIcon
                      : item.project.mode === 'stories'
                        ? AudioLinesIcon
                        : BookOpenIcon;
                  const label =
                    item.kind === 'dub'
                      ? t('projects.dub_projects')
                      : t(item.project.mode === 'stories' ? 'nav.stories' : 'audiobook.title');
                  return (
                    <button
                      key={item.kind + ':' + item.project.id}
                      type="button"
                      className="group flex min-w-0 items-center gap-3 rounded-xl border border-border/50 bg-card/20 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => void openProject(item)}
                    >
                      <Icon className="size-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {item.project.name}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {label}
                        </span>
                      </span>
                      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {profiles.length > 0 && (
            <section className="mt-8">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-medium">{t('clone.saved_profiles')}</h2>
                <Link
                  to="/personas"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('projects.all')}
                </Link>
              </div>
              <div className="grid gap-1 rounded-2xl border border-border/70 bg-card/30 p-2 @3xl:grid-cols-2">
                {profiles.slice(0, 4).map((profile) => (
                  <div
                    key={profile.id}
                    className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-accent/50"
                  >
                    <ProfileAvatar name={profile.name} imageUrl={profile.image_url} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {profile.name}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => void useProfile(profile)}>
                      {t('clone.select_profile')}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
