import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { HighlightedText } from './segment-highlight';

afterEach(() => cleanup());

it('highlights the active spoken word with custom background and font colors', () => {
  render(
    <HighlightedText
      text="Olá mundo novo"
      query=""
      spokenWordIndex={1}
      spokenHighlight={{ backgroundColor: '#2563eb', color: '#ffffff' }}
    />,
  );
  const active = screen.getByText('mundo');
  expect(active.tagName).toBe('MARK');
  expect(active).toHaveAttribute('data-active-word', 'true');
  expect(active).toHaveStyle({ backgroundColor: '#2563eb', color: '#ffffff' });
});
