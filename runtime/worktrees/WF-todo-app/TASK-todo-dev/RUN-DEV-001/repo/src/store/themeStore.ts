import { StateCreator } from 'zustand';
import { Theme, DEFAULT_THEME } from '../model/Theme';

export interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

export const createThemeSlice: StateCreator<ThemeState, [], [], ThemeState> = (set) => ({
  theme: DEFAULT_THEME,

  toggleTheme: () =>
    set((state) => ({
      theme: state.theme === 'light' ? 'dark' : 'light',
    })),

  setTheme: (theme) => set({ theme }),
});
