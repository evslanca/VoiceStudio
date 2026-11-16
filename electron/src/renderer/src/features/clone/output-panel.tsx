import { useEffect, useMemo, useRef } from 'react';
import { AudioLinesIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { activeWordIndex, evenSplitWords } from '@shared/utils/audiobookLyrics';
import { Button } from '@/components/ui/button';
import { ReadingHighlightPicker } from '@/components/reading-highlight-picker';
import { SaveAudioButton } from '@/components/save-audio-button';
import { WaveformPlayer } from '@/components/waveform-player';
import { audioMp3Url, audioUrl } from '@/lib/api/client';
import {
  activePlaybackSource,
  stopActivePlayback,
  usePlaybackSource,
} from '@/lib/audio/playback';
import { requestPlaybackSeek, usePlaybackClock } from '@/lib/audio/playback-clock';
import { clearLatestOutput, useLatestOutput } from '@/lib/store/output';
import { useReadingHighlightColors } from '@/lib/store/reading-highlight';
import { cn } from '@/lib/utils';
import { AudioFileDetails } from './audio-file-details';
import { AudioQuality } from './audio-quality';
import { formatSeconds } from './format';
import { SectionLabel } from './section-label';

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export function OutputPanel() {
  const { t } = useTranslation();
  const { result, objectUrl, text } = useLatestOutput();
  const playback = usePlaybackClock('output');
  const activeSource = usePlaybackSource();
  const { bgColor, textColor } = useReadingHighlightColors();
  const scriptPaneRef = useRef<HTMLDivElement>(null);

  const effectiveDuration = playback.duration || result?.durationSeconds || 0;
  const words = useMemo(
    () => (text ? (evenSplitWords(text, 0, effectiveDuration) as TimedWord[]) : []),
    [effectiveDuration, text],
  );
  const isPlayingOutput = activeSource === 'output' || playback.time > 0;
  const activeWord = isPlayingOutput ? activeWordIndex(words, playback.time) : -1;

  useEffect(() => {
    if (activeWord < 0) return;
    scriptPaneRef.current
      ?.querySelector<HTMLElement>('[data-active-word="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeWord]);

  if (!result || !objectUrl) return null;

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const playbackUrl = result.audioPath ? audioUrl(result.audioPath) : objectUrl;

  return (
    <section
      aria-label={t('clone.output_title')}
      className="w-full shrink-0 border-t border-border/60 bg-muted/15 px-6 py-2"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <SectionLabel>
              <AudioLinesIcon aria-hidden="true" />
              {t('clone.output_title')}
            </SectionLabel>
            {text && words.length === 0 && (
              <p className="min-w-0 truncate text-sm text-muted-foreground" title={text}>
                {text}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {words.length > 0 && <ReadingHighlightPicker compact />}
            <SaveAudioButton
              url={result.audioPath ? audioUrl(result.audioPath) : undefined}
              mp3Url={result.audioPath ? audioMp3Url(result.audioPath) : undefined}
              suggestedName={`voicestudio-${result.id ?? stamp}.wav`}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.close')}
              title={t('common.close')}
              onClick={() => {
                if (activePlaybackSource() === 'output') stopActivePlayback();
                clearLatestOutput();
              }}
            >
              <XIcon />
            </Button>
          </div>
        </div>
        {result && objectUrl ? (
          <>
            <WaveformPlayer key={objectUrl} src={playbackUrl} source="output" height={36} />
            {words.length > 0 && (
              <div
                ref={scriptPaneRef}
                role="region"
                aria-label={t('clone.script')}
                className="max-h-24 overflow-y-auto rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm leading-relaxed text-muted-foreground"
              >
                {words.map((word, index) => {
                  const active = index === activeWord;
                  const spoken = activeWord >= 0 && index < activeWord;
                  return (
                    <span key={`${index}:${word.text}`}>
                      <button
                        type="button"
                        data-active-word={active || undefined}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'rounded px-0.5 text-left text-inherit outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                          spoken && 'text-foreground/75',
                          active && 'font-semibold shadow-xs',
                        )}
                        style={active ? { backgroundColor: bgColor, color: textColor } : undefined}
                        onClick={() => requestPlaybackSeek('output', word.start)}
                      >
                        {word.text}
                      </button>{' '}
                    </span>
                  );
                })}
              </div>
            )}
            {/* One quiet line: length, render time, sample rate; full file facts on hover. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {t('clone.output_meta', {
                  duration: formatSeconds(result.durationSeconds),
                  gen: formatSeconds(result.genTimeSeconds),
                })}
              </span>
              <span aria-hidden="true">·</span>
              <AudioFileDetails blob={result.blob} compact />
              {result.audioPath && <AudioQuality key={objectUrl} audioPath={result.audioPath} />}
            </div>
          </>
        ) : (
          <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed text-[length:var(--text-label)] text-muted-foreground">
            {t('clone.output_empty')}
          </div>
        )}
      </div>
    </section>
  );
}
