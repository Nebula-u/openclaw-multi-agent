import { Badge } from '../ui/Badge';

interface TagChipsProps {
  tags: string[];
  onRemove?: (tag: string) => void;
}

export function TagChips({ tags, onRemove }: TagChipsProps) {
  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <Badge
          key={tag}
          className="bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800"
          onRemove={onRemove ? () => onRemove(tag) : undefined}
        >
          {tag}
        </Badge>
      ))}
    </div>
  );
}
