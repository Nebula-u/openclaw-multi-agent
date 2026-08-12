import { StateCreator } from 'zustand';
import { TaskFilter, TaskSortBy, DEFAULT_FILTER, DEFAULT_SORT } from '../model/Filter';

export interface FilterState {
  filter: TaskFilter;
  sortBy: TaskSortBy;
  setFilter: (partial: Partial<TaskFilter>) => void;
  setSortBy: (sortBy: TaskSortBy) => void;
  resetFilter: () => void;
}

export const createFilterSlice: StateCreator<FilterState, [], [], FilterState> = (set) => ({
  filter: DEFAULT_FILTER,
  sortBy: DEFAULT_SORT,

  setFilter: (partial) =>
    set((state) => ({
      filter: { ...state.filter, ...partial },
    })),

  setSortBy: (sortBy) => set({ sortBy }),

  resetFilter: () =>
    set({
      filter: DEFAULT_FILTER,
      sortBy: DEFAULT_SORT,
    }),
});
