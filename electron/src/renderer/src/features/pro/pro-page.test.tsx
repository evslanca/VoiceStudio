import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/app-shell/workspace-header', () => ({
  WorkspaceHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ProPage } from './pro-page';

afterEach(() => cleanup());

it('renders the EliVoice roadmap items and filters by status', () => {
  render(<ProPage />);

  expect(screen.getByRole('heading', { level: 1, name: 'roadmapPage.title' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 2, name: 'roadmapPage.hero_title' })).toBeVisible();

  expect(screen.getByText('roadmapPage.item_music_studio_title')).toBeVisible();
  expect(screen.getByText('roadmapPage.item_lan_device_sync_title')).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: /roadmapPage\.status_planned/ }));
  expect(screen.queryByText('roadmapPage.item_music_studio_title')).not.toBeInTheDocument();
  expect(screen.getByText('roadmapPage.item_lan_device_sync_title')).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: /roadmapPage\.status_done/ }));
  expect(screen.getByText('roadmapPage.item_music_studio_title')).toBeVisible();
  expect(document.querySelector('a[href="/music"]')).toBeInTheDocument();
});
