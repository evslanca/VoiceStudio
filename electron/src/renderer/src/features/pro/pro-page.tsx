import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  Clock3Icon,
  CompassIcon,
  SparklesIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import './pro-page.css';

type RoadmapStatus = 'done' | 'in_progress' | 'planned';

interface RoadmapItem {
  id: string;
  status: RoadmapStatus;
  to?: '/music' | '/clone' | '/dub' | '/stories' | '/integrations';
}

const ROADMAP_ITEMS: RoadmapItem[] = [
  { id: 'music_studio', status: 'done', to: '/music' },
  { id: 'voice_cloning', status: 'done', to: '/clone' },
  { id: 'dubbing_realtime', status: 'done', to: '/dub' },
  { id: 'stories_audiobooks', status: 'done', to: '/stories' },
  { id: 'stem_separation', status: 'in_progress', to: '/music' },
  { id: 'expressive_prosody', status: 'in_progress' },
  { id: 'mcp_automation', status: 'in_progress', to: '/integrations' },
  { id: 'multitrack_mastering', status: 'planned' },
  { id: 'modular_voice_packs', status: 'planned' },
  { id: 'lan_device_sync', status: 'planned' },
];

const STATUS_META: Record<
  RoadmapStatus,
  { icon: typeof CheckCircle2Icon; badgeClass: string; labelKey: string }
> = {
  done: {
    icon: CheckCircle2Icon,
    badgeClass:
      'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    labelKey: 'roadmapPage.status_done',
  },
  in_progress: {
    icon: SparklesIcon,
    badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    labelKey: 'roadmapPage.status_in_progress',
  },
  planned: {
    icon: Clock3Icon,
    badgeClass: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300',
    labelKey: 'roadmapPage.status_planned',
  },
};

export function ProPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'all' | RoadmapStatus>('all');

  const visibleItems =
    filter === 'all' ? ROADMAP_ITEMS : ROADMAP_ITEMS.filter((item) => item.status === filter);

  const counts = {
    all: ROADMAP_ITEMS.length,
    done: ROADMAP_ITEMS.filter((i) => i.status === 'done').length,
    in_progress: ROADMAP_ITEMS.filter((i) => i.status === 'in_progress').length,
    planned: ROADMAP_ITEMS.filter((i) => i.status === 'planned').length,
  };

  return (
    <div className="pro-page">
      <WorkspaceHeader>
        <div className="flex items-center gap-2">
          <CompassIcon className="size-4 text-primary" aria-hidden="true" />
          <h1 className="text-sm font-medium">{t('roadmapPage.title')}</h1>
        </div>
      </WorkspaceHeader>
      <div className="pro-page-scroll">
        <main className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
          <section className="space-y-3" aria-labelledby="roadmap-hero-title">
            <h2
              id="roadmap-hero-title"
              className="text-3xl font-semibold tracking-[-0.03em] text-foreground"
            >
              {t('roadmapPage.hero_title')}
            </h2>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t('roadmapPage.hero_body')}
            </p>
            <div className="flex flex-wrap gap-2 pt-2" role="group" aria-label={t('roadmapPage.filter_label')}>
              {(
                [
                  ['all', t('roadmapPage.filter_all')],
                  ['done', t('roadmapPage.status_done')],
                  ['in_progress', t('roadmapPage.status_in_progress')],
                  ['planned', t('roadmapPage.status_planned')],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={filter === key ? 'secondary' : 'outline'}
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  <span>{label}</span>
                  <span className="ml-1 rounded-full bg-background/60 px-1.5 py-0.2 text-[11px] tabular-nums text-muted-foreground">
                    {counts[key]}
                  </span>
                </Button>
              ))}
            </div>
          </section>

          <section
            aria-label={t('roadmapPage.items_label')}
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
          >
            {visibleItems.map((item) => {
              const meta = STATUS_META[item.status];
              const StatusIcon = meta.icon;
              return (
                <article
                  key={item.id}
                  data-status={item.status}
                  className="flex flex-col justify-between gap-3 rounded-2xl border border-border/70 bg-card/70 p-4 transition-colors hover:border-border"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge
                        variant="outline"
                        className={cn('gap-1 text-[11px] font-medium', meta.badgeClass)}
                      >
                        <StatusIcon className="size-3" aria-hidden="true" />
                        {t(meta.labelKey)}
                      </Badge>
                    </div>
                    <h3 className="text-base font-semibold text-foreground">
                      {t(`roadmapPage.item_${item.id}_title`)}
                    </h3>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t(`roadmapPage.item_${item.id}_body`)}
                    </p>
                  </div>
                  {item.to && (
                    <div className="pt-1">
                      <Link
                        to={item.to}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                      >
                        <span>{t('roadmapPage.open_feature')}</span>
                        <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                      </Link>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        </main>
      </div>
    </div>
  );
}
