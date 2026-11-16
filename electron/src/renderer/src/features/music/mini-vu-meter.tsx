import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const BAR_COUNT = 8;

/**
 * Compact LED-style VU meter that observes the `<audio>` element inside a
 * track card (`containerRef`) and animates real-time frequency energy when
 * Web Audio API is available, falling back to smooth activity bars while playing.
 */
export function MiniVuMeter({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0.08));

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    let audioEl: HTMLAudioElement | null = null;
    let rafId = 0;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let freqData: Uint8Array<ArrayBuffer> | null = null;

    const attachAnalyser = (el: HTMLAudioElement) => {
      if (analyser) return;
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;
        ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(el);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 32;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      } catch {
        analyser = null;
      }
    };

    const tick = () => {
      if (!audioEl || audioEl.paused || audioEl.ended) {
        setLevels(Array(BAR_COUNT).fill(0.08));
        return;
      }
      if (analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
        const step = Math.max(1, Math.floor(freqData.length / BAR_COUNT));
        const next: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          const val = freqData[Math.min(freqData.length - 1, i * step)] / 255;
          next.push(Math.max(0.12, val));
        }
        setLevels(next);
      } else {
        const now = performance.now() / 120;
        setLevels(
          Array.from({ length: BAR_COUNT }, (_, i) =>
            Math.max(0.18, Math.min(1, 0.45 + 0.45 * Math.sin(now + i * 0.9))),
          ),
        );
      }
      rafId = requestAnimationFrame(tick);
    };

    const onPlay = () => {
      if (audioEl) attachAnalyser(audioEl);
      if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
      setPlaying(true);
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    };

    const onStop = () => {
      setPlaying(false);
      cancelAnimationFrame(rafId);
      setLevels(Array(BAR_COUNT).fill(0.08));
    };

    const bindAudio = () => {
      const found = root.querySelector('audio');
      if (!found || found === audioEl) return;
      if (audioEl) {
        audioEl.removeEventListener('play', onPlay);
        audioEl.removeEventListener('pause', onStop);
        audioEl.removeEventListener('ended', onStop);
      }
      audioEl = found;
      audioEl.addEventListener('play', onPlay);
      audioEl.addEventListener('pause', onStop);
      audioEl.addEventListener('ended', onStop);
      if (!audioEl.paused) onPlay();
    };

    bindAudio();
    const observer = new MutationObserver(bindAudio);
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
      if (audioEl) {
        audioEl.removeEventListener('play', onPlay);
        audioEl.removeEventListener('pause', onStop);
        audioEl.removeEventListener('ended', onStop);
      }
      if (ctx && ctx.state !== 'closed') {
        void ctx.close().catch(() => {});
      }
    };
  }, [containerRef]);

  return (
    <div
      className="flex items-center gap-1.5"
      title={playing ? t('music.vu_playing') : t('music.vu_idle')}
    >
      <div className="flex h-4 items-end gap-0.5 rounded bg-muted/50 px-1.5 py-0.5">
        {levels.map((lvl, idx) => (
          <span
            key={idx}
            style={{ height: `${Math.round(lvl * 100)}%` }}
            className={`w-1 rounded-sm transition-[height] duration-75 ${
              lvl > 0.8
                ? 'bg-rose-500'
                : lvl > 0.55
                  ? 'bg-amber-400'
                  : playing
                    ? 'bg-emerald-500'
                    : 'bg-zinc-500/50'
            }`}
          />
        ))}
      </div>
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {playing ? t('music.vu_playing') : t('music.vu_idle')}
      </span>
    </div>
  );
}
