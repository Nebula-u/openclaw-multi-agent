import { StateCreator } from 'zustand';
import { Task, Priority, Tag, DEFAULT_PRIORITY } from '../model/Task';
import { generateTaskId } from '../utils/idGenerator';

export interface TaskState {
  tasks: Task[];
  addTask: (title: string) => void;
  editTask: (id: string, title: string) => void;
  removeTask: (id: string) => void;
  toggleComplete: (id: string) => void;
  setPriority: (id: string, priority: Priority) => void;
  addTag: (id: string, tag: Tag) => void;
  removeTag: (id: string, tag: Tag) => void;
  importTasks: (tasks: Task[]) => void;
  clearAll: () => void;
}

const MAX_TITLE_LENGTH = 500;
const MAX_TAG_LENGTH = 50;

export const createTaskSlice: StateCreator<TaskState, [], [], TaskState> = (set) => ({
  tasks: [],

  addTask: (title: string) => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) return;

    const now = new Date().toISOString();
    const newTask: Task = {
      id: generateTaskId(),
      title: trimmed,
      completed: false,
      priority: DEFAULT_PRIORITY,
      tags: [],
      createdAt: now,
      updatedAt: now,
    };

    set((state) => ({
      tasks: [newTask, ...state.tasks],
    }));
  },

  editTask: (id: string, title: string) => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) return;

    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id
          ? { ...t, title: trimmed, updatedAt: new Date().toISOString() }
          : t,
      ),
    }));
  },

  removeTask: (id: string) => {
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
    }));
  },

  toggleComplete: (id: string) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id
          ? { ...t, completed: !t.completed, updatedAt: new Date().toISOString() }
          : t,
      ),
    }));
  },

  setPriority: (id: string, priority: Priority) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, priority, updatedAt: new Date().toISOString() } : t,
      ),
    }));
  },

  addTag: (id: string, tag: Tag) => {
    const trimmed = tag.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TAG_LENGTH) return;

    set((state) => ({
      tasks: state.tasks.map((t) => {
        if (t.id !== id) return t;
        if (t.tags.includes(trimmed)) return t; // dedup
        return {
          ...t,
          tags: [...t.tags, trimmed],
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
  },

  removeTag: (id: string, tag: Tag) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              tags: t.tags.filter((tg) => tg !== tag),
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
    }));
  },

  importTasks: (tasks: Task[]) => {
    set({ tasks });
  },

  clearAll: () => {
    set({ tasks: [] });
  },
});
