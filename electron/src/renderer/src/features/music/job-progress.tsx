import { useEffect, useState } from 'react';
import { CheckCircle2Icon, ClockIcon, Loader2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function formatSeconds(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function estimateGenerationSeconds(opts: {
  model: string;
  durationSec: number;
  thinking: boolean;
  useFormat: boolean;
  steps?: number;
  maxMode?: boolean;
}): number {
  const isTurbo = opts.model.includes('turbo');
  const base = isTurbo ? 18 : 42;
  const targetSteps = opts.maxMode ? Math.max(opts.steps || (isTurbo ? 8 : 32), isTurbo ? 12 : 60) : (opts.steps || (isTurbo ? 8 : 32));
  const defaultSteps = isTurbo ? 8 : 32;
  const stepFactor = Math.max(0.75, targetSteps / defaultSteps);
  const rawDur = Number(opts.durationSec) || 30;
  const durFactor = Math.max(0.6, rawDur / 30);
  const multiChapterOverhead = rawDur > 115 ? 12 : 0;
  const lmOverhead = (opts.thinking ? 5 : 0) + (opts.useFormat ? 4 : 0);
  return Math.max(12, Math.min(360, Math.round(base * durFactor * Math.sqrt(stepFactor) + lmOverhead + multiChapterOverhead)));
}

export function computeProgressPct(elapsedSec: number, estimatedSec: number): number {
  if (elapsedSec <= 0) return 4;
  const ratio = elapsedSec / Math.max(1, estimatedSec);
  return Math.min(95, Math.max(5, Math.round(95 * (1 - Math.exp(-2.1 * ratio)))));
}

export function useElapsedSeconds(active: boolean, startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active || !startedAt) {
      setElapsed(0);
      return;
    }
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  return elapsed;
}

export interface DoneNotice {
  label: string;
  elapsedSec: number;
}

interface JobProgressBannerProps {
  active: boolean;
  label: string;
  stage?: string;
  elapsedSec: number;
  estimatedSec: number;
  doneNotice: DoneNotice | null;
}

export function JobProgressBanner({
  active,
  label,
  stage,
  elapsedSec,
  estimatedSec,
  doneNotice,
}: JobProgressBannerProps) {
  const { t } = useTranslation();

  if (active) {
    const pct = computeProgressPct(elapsedSec, estimatedSec);
    const remaining = estimatedSec - elapsedSec;
    const etaText =
      remaining > 0
        ? t('music.eta_remaining', { time: formatSeconds(remaining) })
        : t('music.eta_finishing');

    return (
      <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Loader2Icon className="size-3.5 animate-spin text-primary" />
            <span>{label}</span>
            {stage && (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                {stage}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <ClockIcon className="size-3" />
            <span>
              {formatSeconds(elapsedSec)} / ~{formatSeconds(estimatedSec)}
            </span>
            <span className="text-primary">• {etaText}</span>
            <span className="font-semibold text-foreground">{pct}%</span>
          </div>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (doneNotice) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
        <div className="flex items-center gap-2 font-medium">
          <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" />
          <span>{doneNotice.label}</span>
        </div>
        <span className="font-mono text-[11px] font-semibold">
          {t('music.done_in', { time: formatSeconds(doneNotice.elapsedSec) })}
        </span>
      </div>
    );
  }

  return null;
}
