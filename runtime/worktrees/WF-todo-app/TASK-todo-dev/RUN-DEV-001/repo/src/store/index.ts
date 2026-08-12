import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { TaskState, createTaskSlice } from './taskStore';
import { FilterState, createFilterSlice } from './filterStore';
import { ThemeState, createThemeSlice } from './themeStore';

export type AppState = TaskState & FilterState & ThemeState;

export const useAppStore = create<AppState>()(
  persist(
    (...args) => ({
      ...createTaskSlice(...args),
      ...createFilterSlice(...args),
      ...createThemeSlice(...args),
    }),
    {
      name: 'todo-tasks',
      partialize: (state) => ({
        tasks: state.tasks,
        theme: state.theme,
      }),
    },
  ),
);
