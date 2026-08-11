export type TaskId = string;

export enum Priority {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export type Tag = string;

export interface Task {
  id: TaskId;
  title: string;
  completed: boolean;
  priority: Priority;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  [Priority.HIGH]: '高',
  [Priority.MEDIUM]: '中',
  [Priority.LOW]: '低',
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  [Priority.HIGH]: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 border-red-200 dark:border-red-800',
  [Priority.MEDIUM]: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  [Priority.LOW]: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400 border-green-200 dark:border-green-800',
};

export const PRIORITY_DOT_COLORS: Record<Priority, string> = {
  [Priority.HIGH]: 'bg-red-500',
  [Priority.MEDIUM]: 'bg-amber-500',
  [Priority.LOW]: 'bg-green-500',
};

export const PRIORITY_ORDER: Record<Priority, number> = {
  [Priority.HIGH]: 3,
  [Priority.MEDIUM]: 2,
  [Priority.LOW]: 1,
};

export const DEFAULT_PRIORITY = Priority.MEDIUM;
