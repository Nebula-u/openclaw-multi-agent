import { useTaskStats } from '../../hooks/useFilteredTasks';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  const stats = useTaskStats();

  return (
    <header className="sticky top-0 z-40 bg-white/80 dark:bg-gray-900/80 backdrop-blur-lg border-b border-gray-200 dark:border-gray-800">
      <div className="max-w-3xl mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-violet-500 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 dark:text-white leading-tight">Todo</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {stats.total > 0
                ? `${stats.completed} / ${stats.total} 已完成`
                : '暂无任务'}
            </p>
          </div>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
