import { Store } from '@tanstack/store';
import { useStore } from '@tanstack/react-store';

export interface ReadingHighlightColors {
  bgColor: string;
  textColor: string;
}

export interface ReadingHighlightPreset extends ReadingHighlightColors {
  id: string;
}

export const DEFAULT_READING_HIGHLIGHT: ReadingHighlightColors = {
  bgColor: '#facc15',
  textColor: '#09090b',
};

export const READING_HIGHLIGHT_PRESETS: ReadingHighlightPreset[] = [
  { id: 'amber', bgColor: '#facc15', textColor: '#09090b' },
  { id: 'blue', bgColor: '#2563eb', textColor: '#ffffff' },
  { id: 'emerald', bgColor: '#10b981', textColor: '#052e16' },
  { id: 'rose', bgColor: '#f43f5e', textColor: '#ffffff' },
  { id: 'violet', bgColor: '#8b5cf6', textColor: '#ffffff' },
  { id: 'contrast', bgColor: '#ffffff', textColor: '#09090b' },
];

const STORAGE_KEY = 'elivoice.readingHighlight';

function loadStoredColors(): ReadingHighlightColors {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_READING_HIGHLIGHT;
    const parsed = JSON.parse(raw) as Partial<ReadingHighlightColors>;
    if (
      typeof parsed?.bgColor === 'string' &&
      parsed.bgColor.trim() &&
      typeof parsed?.textColor === 'string' &&
      parsed.textColor.trim()
    ) {
      return { bgColor: parsed.bgColor, textColor: parsed.textColor };
    }
  } catch {
    // Ignore storage errors and fall back to defaults.
  }
  return DEFAULT_READING_HIGHLIGHT;
}

function saveStoredColors(colors: ReadingHighlightColors): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // Ignore storage quota or sandbox errors.
  }
}

const highlightStore = new Store<ReadingHighlightColors>(loadStoredColors());

export function useReadingHighlightColors(): ReadingHighlightColors {
  return useStore(highlightStore, (state) => state);
}

export function setReadingHighlightColors(patch: Partial<ReadingHighlightColors>): void {
  highlightStore.setState((current) => {
    const next: ReadingHighlightColors = {
      bgColor: typeof patch.bgColor === 'string' && patch.bgColor.trim() ? patch.bgColor : current.bgColor,
      textColor:
        typeof patch.textColor === 'string' && patch.textColor.trim() ? patch.textColor : current.textColor,
    };
    saveStoredColors(next);
    return next;
  });
}

export function resetReadingHighlightColors(): void {
  highlightStore.setState(() => {
    saveStoredColors(DEFAULT_READING_HIGHLIGHT);
    return DEFAULT_READING_HIGHLIGHT;
  });
}
