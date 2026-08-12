import { useMemo } from 'react';
import { useAppStore } from '../store';
import { filterAndSort, extractAllTags } from '../utils/taskFilter';
import { Task, Tag } from '../model/Task';

export function useFilteredTasks(): Task[] {
  const tasks = useAppStore((s) => s.tasks);
  const filter = useAppStore((s) => s.filter);
  const sortBy = useAppStore((s) => s.sortBy);

  return useMemo(() => filterAndSort(tasks, filter, sortBy), [tasks, filter, sortBy]);
}

export function useAllTags(): Tag[] {
  const tasks = useAppStore((s) => s.tasks);
  return useMemo(() => extractAllTags(tasks), [tasks]);
}

export interface TaskStats {
  total: number;
  completed: number;
  active: number;
}

export function useTaskStats(): TaskStats {
  const tasks = useAppStore((s) => s.tasks);
  return useMemo(() => {
    const completed = tasks.filter((t) => t.completed).length;
    return {
      total: tasks.length,
      completed,
      active: tasks.length - completed,
    };
  }, [tasks]);
}
