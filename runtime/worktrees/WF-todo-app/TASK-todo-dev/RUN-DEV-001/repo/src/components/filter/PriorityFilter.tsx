import { useAppStore } from '../../store';
import { Priority } from '../../model/Task';
import { PRIORITY_OPTIONS } from '../task/PriorityBadge';

export function PriorityFilter() {
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);

  return (
    <div className="flex gap-1 flex-wrap">
      <button
        onClick={() => setFilter({ priority: null })}
        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${
          filter.priority === null
            ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-400'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
        }`}
      >
        全部
      </button>
      {PRIORITY_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() =>
            setFilter({
              priority: filter.priority === opt.value ? null : (opt.value as Priority),
            })
          }
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${
            filter.priority === opt.value
              ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-400 ring-1 ring-primary-300 dark:ring-primary-600'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {opt.label.replace(/[🔴🟡🟢]\s*/, '')}
        </button>
      ))}
    </div>
  );
}
