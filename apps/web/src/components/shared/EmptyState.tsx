import { cn } from '../../lib/utils';
import { Card } from '../ui/Card';

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('grid justify-items-start gap-2', className)}>
      <h3 className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h3>
      <p className="text-sm text-[var(--color-text-secondary)]">{description}</p>
      {action}
    </Card>
  );
}
