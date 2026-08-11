import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';

interface TaskEditFormProps {
  initialTitle: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}

export function TaskEditForm({ initialTitle, onSave, onCancel }: TaskEditFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSave = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed.length <= 500) {
      onSave(trimmed);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div className="flex gap-2 w-full">
      <Input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1"
      />
      <Button size="sm" onClick={handleSave}>
        保存
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        取消
      </Button>
    </div>
  );
}
