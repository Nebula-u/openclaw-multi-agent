import { useAppStore } from '../../store';
import { TaskSortBy, SORT_LABELS } from '../../model/Filter';

export function SortSelector() {
  const sortBy = useAppStore((s) => s.sortBy);
  const setSortBy = useAppStore((s) => s.setSortBy);

  const options: TaskSortBy[] = [
    'created-desc',
    'created-asc',
    'priority-desc',
    'priority-asc',
    'title-asc',
  ];

  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => setSortBy(opt)}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${
            sortBy === opt
              ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-400 ring-1 ring-primary-300 dark:ring-primary-600'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {SORT_LABELS[opt]}
        </button>
      ))}
    </div>
  );
}
