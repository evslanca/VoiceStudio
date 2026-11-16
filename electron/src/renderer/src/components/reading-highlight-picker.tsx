import { Popover } from '@base-ui/react/popover';
import { PaletteIcon, RotateCcwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DEFAULT_READING_HIGHLIGHT,
  READING_HIGHLIGHT_PRESETS,
  resetReadingHighlightColors,
  setReadingHighlightColors,
  useReadingHighlightColors,
} from '@/lib/store/reading-highlight';
import { cn } from '@/lib/utils';

export function ReadingHighlightPicker({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { bgColor, textColor } = useReadingHighlightColors();
  const isDefault =
    bgColor.toLowerCase() === DEFAULT_READING_HIGHLIGHT.bgColor &&
    textColor.toLowerCase() === DEFAULT_READING_HIGHLIGHT.textColor;

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={t('readingHighlight.button')}
        title={t('readingHighlight.button')}
        className={cn(
          buttonVariants({ variant: 'ghost', size: compact ? 'xs' : 'sm' }),
          'gap-1.5',
          className,
        )}
      >
        <PaletteIcon className="size-3.5" aria-hidden="true" />
        <span
          className="inline-flex size-3.5 items-center justify-center rounded-sm border border-border/70 text-[9px] font-bold leading-none"
          style={{ backgroundColor: bgColor, color: textColor }}
          aria-hidden="true"
        >
          A
        </span>
        {!compact && <span>{t('readingHighlight.button')}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className="w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">{t('readingHighlight.title')}</span>
              {!isDefault && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={resetReadingHighlightColors}
                >
                  <RotateCcwIcon className="size-3" aria-hidden="true" />
                  {t('readingHighlight.reset')}
                </Button>
              )}
            </div>

            <div className="mb-3 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-center text-xs text-muted-foreground">
              <span
                data-testid="reading-highlight-preview"
                className="inline-block rounded px-1.5 py-0.5 font-semibold shadow-xs"
                style={{ backgroundColor: bgColor, color: textColor }}
              >
                {t('readingHighlight.previewWord')}
              </span>
            </div>

            <div className="mb-3 grid grid-cols-6 gap-1.5">
              {READING_HIGHLIGHT_PRESETS.map((preset) => {
                const selected =
                  preset.bgColor.toLowerCase() === bgColor.toLowerCase() &&
                  preset.textColor.toLowerCase() === textColor.toLowerCase();
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-label={`${t('readingHighlight.preset')} ${preset.id}`}
                    aria-pressed={selected}
                    className={cn(
                      'flex h-7 items-center justify-center rounded-md border text-[11px] font-bold transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring',
                      selected ? 'border-foreground ring-1 ring-foreground' : 'border-border/70',
                    )}
                    style={{ backgroundColor: preset.bgColor, color: preset.textColor }}
                    onClick={() =>
                      setReadingHighlightColors({
                        bgColor: preset.bgColor,
                        textColor: preset.textColor,
                      })
                    }
                  >
                    Aa
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex cursor-pointer flex-col gap-1 rounded-lg border border-border/60 bg-background/40 p-2 text-[11px] font-medium text-muted-foreground">
                <span>{t('readingHighlight.background')}</span>
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('readingHighlight.background')}
                    value={bgColor}
                    onChange={(event) => setReadingHighlightColors({ bgColor: event.target.value })}
                    className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <span className="font-mono text-[10px] uppercase text-foreground">{bgColor}</span>
                </span>
              </label>

              <label className="flex cursor-pointer flex-col gap-1 rounded-lg border border-border/60 bg-background/40 p-2 text-[11px] font-medium text-muted-foreground">
                <span>{t('readingHighlight.font')}</span>
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('readingHighlight.font')}
                    value={textColor}
                    onChange={(event) =>
                      setReadingHighlightColors({ textColor: event.target.value })
                    }
                    className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <span className="font-mono text-[10px] uppercase text-foreground">
                    {textColor}
                  </span>
                </span>
              </label>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
