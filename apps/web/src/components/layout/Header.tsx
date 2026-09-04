import { cn } from '../../lib/utils';
import type { Route } from '../../types';

const TABS: { id: Route['page']; label: string }[] = [
  { id: 'applications', label: 'Applications' },
  { id: 'connect', label: 'Connect Calendar' },
];

export function Header({
  route,
  onNavigate,
  userEmail,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  userEmail: string;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface-base)]/95 backdrop-blur">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-5">
          <div className="text-xl font-semibold tracking-tight">
            <span className="text-[var(--color-accent)]">CalDAV</span>
            <span className="text-[var(--color-text-primary)]"> Bridge</span>
          </div>

          <nav aria-label="Primary Navigation" className="flex items-center rounded-lg bg-[var(--color-surface-2)] p-1 gap-0.5">
            {TABS.map((tab) => {
              const isActive = route.page === tab.id || (tab.id === 'applications' && route.page === 'details');
              return (
                <button
                  key={tab.id}
                  onClick={() => onNavigate(tab.id === 'applications' ? { page: 'applications' } : { page: 'connect' })}
                  className={cn(
                    'px-3.5 py-1.5 rounded-md text-sm transition-colors duration-150',
                    isActive
                      ? 'bg-[var(--color-surface-4)] text-[var(--color-text-primary)] font-medium'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="text-sm text-[var(--color-text-muted)] truncate max-w-xs">{userEmail}</div>
      </div>
    </header>
  );
}
