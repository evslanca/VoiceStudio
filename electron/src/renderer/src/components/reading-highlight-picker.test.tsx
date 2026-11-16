import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ReadingHighlightPicker } from './reading-highlight-picker';
import {
  DEFAULT_READING_HIGHLIGHT,
  resetReadingHighlightColors,
} from '@/lib/store/reading-highlight';

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetReadingHighlightColors();
});

it('updates and persists background and font highlight colors and resets to default', async () => {
  render(<ReadingHighlightPicker />);
  fireEvent.click(screen.getByRole('button', { name: 'readingHighlight.button' }));

  const preview = await screen.findByTestId('reading-highlight-preview');
  expect(preview).toHaveStyle({
    backgroundColor: DEFAULT_READING_HIGHLIGHT.bgColor,
    color: DEFAULT_READING_HIGHLIGHT.textColor,
  });

  const bgInput = screen.getByLabelText('readingHighlight.background');
  const fontInput = screen.getByLabelText('readingHighlight.font');
  fireEvent.change(bgInput, { target: { value: '#1e293b' } });
  fireEvent.change(fontInput, { target: { value: '#38bdf8' } });

  expect(preview).toHaveStyle({
    backgroundColor: '#1e293b',
    color: '#38bdf8',
  });
  expect(JSON.parse(localStorage.getItem('elivoice.readingHighlight') || '{}')).toEqual({
    bgColor: '#1e293b',
    textColor: '#38bdf8',
  });

  fireEvent.click(screen.getByRole('button', { name: /readingHighlight\.reset/ }));
  expect(preview).toHaveStyle({
    backgroundColor: DEFAULT_READING_HIGHLIGHT.bgColor,
    color: DEFAULT_READING_HIGHLIGHT.textColor,
  });
});
