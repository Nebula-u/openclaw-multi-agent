import { AnimatePresence } from 'framer-motion';
import { useFilteredTasks, useAllTags } from '../../hooks/useFilteredTasks';
import { useAppStore } from '../../store';
import { TaskItem } from './TaskItem';
import { EmptyState } from '../common/EmptyState';

export function TaskList() {
  const tasks = useFilteredTasks();
  const allTasks = useAppStore((s) => s.tasks);
  const filter = useAppStore((s) => s.filter);
  const allTags = useAllTags();

  const isFiltering = filter.priority !== null || filter.tag !== null || filter.hideCompleted;

  // Determine empty state message
  if (allTasks.length === 0) {
    return (
      <EmptyState
        icon="📝"
        title="还没有任何任务"
        description="在上方输入框添加你的第一个任务吧"
      />
    );
  }

  if (tasks.length === 0 && isFiltering) {
    return (
      <EmptyState
        icon="🔍"
        title="没有匹配的任务"
        description="尝试调整筛选条件查看更多任务"
      />
    );
  }

  if (tasks.length === 0 && allTasks.length > 0) {
    return (
      <EmptyState
        icon="🎉"
        title="所有任务已完成"
        description="干得漂亮！所有任务都已完成"
      />
    );
  }

  return (
    <div className="space-y-2">
      <AnimatePresence mode="popLayout">
        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} />
        ))}
      </AnimatePresence>
    </div>
  );
}

export { useAllTags };
