import { Priority, PRIORITY_COLORS, PRIORITY_LABELS, PRIORITY_DOT_COLORS } from '../../model/Task';
import clsx from 'clsx';

interface PriorityBadgeProps {
  priority: Priority;
  showDot?: boolean;
  className?: string;
}

export function PriorityBadge({ priority, showDot = true, className }: PriorityBadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-medium border',
        PRIORITY_COLORS[priority],
        className,
      )}
    >
      {showDot && <span className={clsx('w-1.5 h-1.5 rounded-full', PRIORITY_DOT_COLORS[priority])} />}
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export const PRIORITY_OPTIONS = [
  { value: 'HIGH' as const, label: '🔴 高优先级' },
  { value: 'MEDIUM' as const, label: '🟡 中优先级' },
  { value: 'LOW' as const, label: '🟢 低优先级' },
];
