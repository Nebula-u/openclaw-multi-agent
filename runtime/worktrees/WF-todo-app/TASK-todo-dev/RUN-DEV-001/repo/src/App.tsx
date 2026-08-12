import { useEffect } from 'react';
import { useAppStore } from './store';
import { AppShell } from './components/layout/AppShell';
import { AddTaskForm } from './components/task/AddTaskForm';
import { FilterBar } from './components/filter/FilterBar';
import { TaskList } from './components/task/TaskList';

export default function App() {
  const theme = useAppStore((s) => s.theme);
  const addTask = useAppStore((s) => s.addTask);

  // Sync theme class on document
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  // Apply initial theme on mount
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddTask = (title: string) => {
    addTask(title);
  };

  return (
    <AppShell>
      <div className="space-y-4">
        <AddTaskForm onAdd={handleAddTask} />
        <FilterBar />
        <TaskList />
      </div>
    </AppShell>
  );
}
