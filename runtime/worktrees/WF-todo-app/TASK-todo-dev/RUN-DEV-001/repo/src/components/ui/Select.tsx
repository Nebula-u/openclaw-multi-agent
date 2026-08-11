import React from 'react';
import clsx from 'clsx';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

export function Select({ label, className, children, ...props }: SelectProps) {
  return (
    <div>
      {label && (
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {label}
        </label>
      )}
      <select
        className={clsx(
          'w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700',
          'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100',
          'text-sm transition-all duration-200',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
          'cursor-pointer',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    </div>
  );
}
