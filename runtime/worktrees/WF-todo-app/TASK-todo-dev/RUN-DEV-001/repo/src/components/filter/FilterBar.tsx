import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '../../store';
import { PriorityFilter } from './PriorityFilter';
import { TagFilter } from './TagFilter';
import { SortSelector } from './SortSelector';
import { Button } from '../ui/Button';

export function FilterBar() {
  const [expanded, setExpanded] = useState(false);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  const resetFilter = useAppStore((s) => s.resetFilter);

  const isFiltering = filter.priority !== null || filter.tag !== null || filter.hideCompleted;

  return (
    <div className="mb-4 space-y-3">
      {/* Quick filter row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setFilter({ hideCompleted: !filter.hideCompleted })}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
            filter.hideCompleted
              ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-400'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {filter.hideCompleted ? '✓ 隐藏已完成' : '隐藏已完成'}
        </button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          className="text-xs"
        >
          <svg
            className={`w-4 h-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          {expanded ? '收起筛选' : '展开筛选'}
        </Button>

        {isFiltering && (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilter}
            className="text-xs text-amber-600 dark:text-amber-400"
          >
            重置
          </Button>
        )}
      </div>

      {/* Expanded filter panel */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="p-4 rounded-2xl bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 space-y-4">
              <div>
                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                  优先级筛选
                </h4>
                <PriorityFilter />
              </div>
              <div>
                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                  标签筛选
                </h4>
                <TagFilter />
              </div>
              <div>
                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                  排序方式
                </h4>
                <SortSelector />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
