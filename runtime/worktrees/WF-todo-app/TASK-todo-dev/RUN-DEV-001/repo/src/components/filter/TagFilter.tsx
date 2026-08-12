import { useAllTags } from '../../hooks/useFilteredTasks';
import { useAppStore } from '../../store';

export function TagFilter() {
  const tags = useAllTags();
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);

  if (tags.length === 0) return null;

  return (
    <div className="flex gap-1 flex-wrap">
      <button
        onClick={() => setFilter({ tag: null })}
        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${
          filter.tag === null
            ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
        }`}
      >
        全部标签
      </button>
      {tags.map((tag) => (
        <button
          key={tag}
          onClick={() =>
            setFilter({ tag: filter.tag === tag ? null : tag })
          }
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${
            filter.tag === tag
              ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400 ring-1 ring-violet-300 dark:ring-violet-600'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {tag}
        </button>
      ))}
    </div>
  );
}
