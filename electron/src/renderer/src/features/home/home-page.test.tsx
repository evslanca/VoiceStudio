import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const queryMockData = vi.hoisted(() => ({
  status: null as { installed: boolean; running: boolean; healthy: boolean } | null,
  library: [] as Array<{
    id: string;
    url: string;
    title?: string | null;
    prompt: string;
    bpm?: number | null;
    duration?: number | null;
  }>,
  exports: [] as Array<{ id: string; filename: string; destination_path: string; mode?: string }>,
  projects: [] as Array<{ id: string; name: string; updated_at?: number }>,
  longform: [] as Array<{
    id: string;
    name: string;
    mode: 'stories' | 'audiobook';
    updatedAt: number;
    draft: Record<string, unknown>;
  }>,
}));

const mockProfiles = vi.hoisted(() => ({
  data: [] as Array<{ id: string; name: string; image_url?: string | null; kind?: string }>,
}));

const navigateMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/components/bridge', () => ({
  getBridge: () => ({ app: { version: '0.0.0-test', isDev: false } }),
  appVersion: () => '0.0.0-test',
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = String(queryKey?.[0] ?? '');
    if (key === 'home-music-status') return { data: queryMockData.status };
    if (key === 'home-music-library') return { data: queryMockData.library };
    if (key === 'export-history') return { data: queryMockData.exports };
    if (key === 'projects') return { data: queryMockData.projects };
    if (key === 'longform-projects') return { data: queryMockData.longform };
    return { data: [] };
  },
}));

vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({ data: mockProfiles.data }),
}));

vi.mock('@/components/app-shell/workspace-header', () => ({
  WorkspaceHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import en from '@/i18n/locales/en.json';
import pt from '@/i18n/locales/pt.json';
import { HomePage } from './home-page';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  queryMockData.status = null;
  queryMockData.library = [];
  queryMockData.exports = [];
  queryMockData.projects = [];
  queryMockData.longform = [];
  mockProfiles.data = [];
  navigateMock.mockClear();
});

it('displays EliVoice branding cleanly without external VoiceStudio or contributor links', () => {
  render(<HomePage />);
  expect(en.homeUi.title).toBe('EliVoice');
  expect(pt.homeUi.title).toBe('EliVoice');
  expect(en.homeUi.subtitle).not.toMatch(/voicestudio|elevenlabs|646/i);
  expect(pt.homeUi.subtitle).not.toMatch(/voicestudio|elevenlabs|646/i);

  const heading = screen.getByRole('heading', { name: 'homeUi.title' });
  expect(heading).toBeVisible();
  expect(screen.getByText('homeUi.subtitle')).toBeVisible();
  expect(screen.getByText('app.version')).toBeVisible();

  expect(document.querySelector('a[href*="voicestudio.sh"]')).toBeNull();
  expect(document.querySelector('a[href*="debpalash"]')).toBeNull();
  expect(screen.queryByText('homeUi.allContributors')).toBeNull();
});

it('shows EliVoice overview metrics beside the header and links to Music Studio and Projects', () => {
  queryMockData.status = { installed: true, running: true, healthy: true };
  queryMockData.library = [
    { id: 't1', url: '/audio/1.mp3', title: 'Bossa Nova', prompt: 'bossa', bpm: 118, duration: 152 },
  ];
  queryMockData.projects = [{ id: 'p1', name: 'Video Dub' }];
  queryMockData.exports = [{ id: 'e1', filename: 'final.mp4', destination_path: '/tmp/final.mp4' }];
  mockProfiles.data = [{ id: 'v1', name: 'Ana' }, { id: 'v2', name: 'Carlos' }];

  render(<HomePage />);
  const overview = screen.getByRole('region', { name: 'homeUi.overview' });
  expect(overview).toHaveTextContent('music.online');
  expect(overview).toHaveTextContent('2');
  expect(overview).toHaveTextContent('1');

  const recentMusicSection = screen.getByText('homeUi.recentMusic').closest('section');
  expect(recentMusicSection).toHaveTextContent('Bossa Nova');
  expect(recentMusicSection).toHaveTextContent('118 BPM · 2:32');

  fireEvent.click(screen.getAllByRole('button', { name: /clone\.select_profile/ })[0]);
  expect(navigateMock).toHaveBeenCalledWith({ to: '/clone' });
});

it('features Music Studio in primary cards and covers all new EliVoice studios in secondary cards', () => {
  render(<HomePage />);
  const musicCard = document.querySelector('.home-destinations--primary a[href="/music"]');
  expect(musicCard).toBeInTheDocument();

  const primaryLinks = Array.from(
    document.querySelectorAll('.home-destinations--primary a'),
    (el) => el.getAttribute('href'),
  );
  expect(primaryLinks).toEqual(['/music', '/clone', '/design', '/dub']);

  const secondaryLinks = Array.from(
    document.querySelectorAll('.home-destinations--secondary a'),
    (el) => el.getAttribute('href'),
  );
  expect(secondaryLinks).toEqual([
    '/stories',
    '/audiobook',
    '/batch',
    '/transcriptions',
    '/personas',
    '/gallery',
    '/workflows',
    '/tools',
    '/integrations',
  ]);

  const icons = document.querySelectorAll('svg.home-feature-svg');
  expect(icons).toHaveLength(13);
  icons.forEach((icon) => expect(icon).toHaveAttribute('aria-hidden', 'true'));
});

it('renders seasonal pixel snow only in winter months', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2027, 0, 10));
  const { unmount } = render(<HomePage />);
  expect(screen.getByTestId('home-snow')).toBeInTheDocument();
  unmount();
  vi.setSystemTime(new Date(2026, 6, 1));
  render(<HomePage />);
  expect(screen.queryByTestId('home-snow')).toBeNull();
});
