import React from 'react';
import { Header } from './Header';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors duration-300">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6">{children}</main>
      <footer className="max-w-3xl mx-auto px-4 pb-8 text-center">
        <p className="text-xs text-gray-400 dark:text-gray-600">
          Todo App · 数据安全存储在浏览器本地
        </p>
      </footer>
    </div>
  );
}
