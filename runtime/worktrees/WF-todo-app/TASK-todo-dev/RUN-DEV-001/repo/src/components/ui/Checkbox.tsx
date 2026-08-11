import clsx from 'clsx';

interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  className?: string;
}

export function Checkbox({ checked, onChange, className }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onChange}
      className={clsx(
        'w-5 h-5 rounded-md border-2 flex items-center justify-center',
        'transition-all duration-200 flex-shrink-0',
        checked
          ? 'bg-primary-500 border-primary-500'
          : 'border-gray-300 dark:border-gray-600 hover:border-primary-400',
        className,
      )}
    >
      {checked && (
        <svg
          className="w-3 h-3 text-white"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M2.5 6.5L5 9L9.5 3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
