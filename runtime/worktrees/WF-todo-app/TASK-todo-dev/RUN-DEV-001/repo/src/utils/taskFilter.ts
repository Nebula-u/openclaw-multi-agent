import { Task, Tag, PRIORITY_ORDER } from '../model/Task';
import { TaskFilter, TaskSortBy } from '../model/Filter';

export function filterAndSort(tasks: Task[], filter: TaskFilter, sortBy: TaskSortBy): Task[] {
  let result = [...tasks];

  // Apply filters
  if (filter.hideCompleted) {
    result = result.filter((t) => !t.completed);
  }

  if (filter.priority !== null) {
    result = result.filter((t) => t.priority === filter.priority);
  }

  if (filter.tag !== null) {
    result = result.filter((t) => t.tags.includes(filter.tag!));
  }

  // Apply sort
  result.sort((a, b) => {
    switch (sortBy) {
      case 'created-desc':
        return b.createdAt.localeCompare(a.createdAt);
      case 'created-asc':
        return a.createdAt.localeCompare(b.createdAt);
      case 'priority-desc':
        return PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
      case 'priority-asc':
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      case 'title-asc':
        return a.title.localeCompare(b.title, 'zh-CN');
      default:
        return 0;
    }
  });

  return result;
}

export function extractAllTags(tasks: Task[]): Tag[] {
  const tagSet = new Set<Tag>();
  for (const task of tasks) {
    for (const tag of task.tags) {
      tagSet.add(tag);
    }
  }
  return Array.from(tagSet).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
