import { Priority, Tag } from './Task';

export interface TaskFilter {
  priority: Priority | null;
  tag: Tag | null;
  hideCompleted: boolean;
}

export type TaskSortBy =
  | 'created-desc'
  | 'created-asc'
  | 'priority-desc'
  | 'priority-asc'
  | 'title-asc';

export const SORT_LABELS: Record<TaskSortBy, string> = {
  'created-desc': '最新在前',
  'created-asc': '最早在前',
  'priority-desc': '优先级高→低',
  'priority-asc': '优先级低→高',
  'title-asc': '标题 A→Z',
};

export const DEFAULT_FILTER: TaskFilter = {
  priority: null,
  tag: null,
  hideCompleted: false,
};

export const DEFAULT_SORT: TaskSortBy = 'created-desc';
