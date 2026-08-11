import { useState, KeyboardEvent } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';

interface AddTaskFormProps {
  onAdd: (title: string) => void;
}

export function AddTaskForm({ onAdd }: AddTaskFormProps) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('任务标题不能为空');
      return;
    }
    if (trimmed.length > 500) {
      setError('任务标题不能超过 500 个字符');
      return;
    }
    setError('');
    onAdd(trimmed);
    setTitle('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  return (
    <div className="flex gap-2">
      <Input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          if (error) setError('');
        }}
        onKeyDown={handleKeyDown}
        placeholder="添加新任务..."
        error={error}
        className="flex-1"
        aria-label="新任务标题"
      />
      <Button onClick={handleSubmit} size="lg" className="flex-shrink-0">
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        添加
      </Button>
    </div>
  );
}
