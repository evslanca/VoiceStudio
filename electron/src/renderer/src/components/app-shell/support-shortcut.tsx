import { Link } from '@tanstack/react-router';
import { BlocksIcon, MusicIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import './support-shortcut.css';

export function SupportShortcut() {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/music"
              aria-label={t('music.title')}
              className="support-shortcut app-no-drag flex items-center gap-1 px-1.5 focus-visible:outline-2 focus-visible:outline-ring"
            />
          }
        >
          <MusicIcon aria-hidden="true" className="size-3.5" />
          <span className="hidden text-xs font-medium sm:inline">{t('nav.music')}</span>
        </TooltipTrigger>
        <TooltipContent surface="theme" side="bottom">
          {t('music.title')}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/integrations"
              aria-label={t('integrationCatalog.title')}
              className="support-shortcut app-no-drag flex items-center gap-1 px-1.5 focus-visible:outline-2 focus-visible:outline-ring"
            />
          }
        >
          <BlocksIcon aria-hidden="true" className="size-3.5" />
          <span className="hidden text-xs font-medium sm:inline">
            {t('integrationCatalog.title')}
          </span>
        </TooltipTrigger>
        <TooltipContent surface="theme" side="bottom">
          {t('integrationCatalog.title')}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
