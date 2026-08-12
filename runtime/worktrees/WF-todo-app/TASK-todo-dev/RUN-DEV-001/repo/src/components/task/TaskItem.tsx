import { useState } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { Task, Priority } from '../../model/Task';
import { useAppStore } from '../../store';
import { Checkbox } from '../ui/Checkbox';
import { Button } from '../ui/Button';
import { PriorityBadge, PRIORITY_OPTIONS } from './PriorityBadge';
import { TagChips } from './TagChips';
import { TaskEditForm } from './TaskEditForm';

interface TaskItemProps {
  task: Task;
}

export function TaskItem({ task }: TaskItemProps) {
  const [editing, setEditing] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);

  const toggleComplete = useAppStore((s) => s.toggleComplete);
  const removeTask = useAppStore((s) => s.removeTask);
  const editTask = useAppStore((s) => s.editTask);
  const setPriority = useAppStore((s) => s.setPriority);
  const addTag = useAppStore((s) => s.addTag);
  const removeTag = useAppStore((s) => s.removeTag);

  const handleSaveEdit = (title: string) => {
    editTask(task.id, title);
    setEditing(false);
  };

  const handleAddTag = () => {
    const trimmed = tagInput.trim();
    if (trimmed) {
      addTag(task.id, trimmed);
      setTagInput('');
      setAddingTag(false);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      className={clsx(
        'group rounded-2xl border transition-all duration-200',
        task.completed
          ? 'bg-gray-50/80 dark:bg-gray-900/50 border-gray-100 dark:border-gray-800'
          : 'bg-white dark:bg-gray-800/80 border-gray-200 dark:border-gray-700 hover:border-primary-300 dark:hover:border-primary-600 hover:shadow-md',
      )}
    >
      <div className="p-4">
        {editing ? (
          <TaskEditForm
            initialTitle={task.title}
            onSave={handleSaveEdit}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="flex items-start gap-3">
            <Checkbox
              checked={task.completed}
              onChange={() => toggleComplete(task.id)}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={clsx(
                    'text-sm font-medium leading-snug break-words',
                    task.completed
                      ? 'text-gray-400 dark:text-gray-500 line-through'
                      : 'text-gray-900 dark:text-gray-100',
                  )}
                >
                  {task.title}
                </span>
                <PriorityBadge priority={task.priority} />
              </div>

              <TagChips tags={task.tags} onRemove={(tag) => removeTag(task.id, tag)} />

              <div className="mt-2 text-[10px] text-gray-400 dark:text-gray-600">
                {new Date(task.createdAt).toLocaleString('zh-CN')}
              </div>
            </div>

            {/* Actions — visible on hover */}
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              {/* Priority menu */}
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowPriorityMenu(!showPriorityMenu)}
                  title="设置优先级"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                  </svg>
                </Button>
                {showPriorityMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-20 min-w-[140px]">
                    {PRIORITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        className={clsx(
                          'w-full text-left px-3 py-2 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700',
                          task.priority === opt.value && 'bg-primary-50 dark:bg-primary-900/20',
                        )}
                        onClick={() => {
                          setPriority(task.id, opt.value as Priority);
                          setShowPriorityMenu(false);
                        }}
                      >
                        {opt.label}
                        {task.priority === opt.value && (
                          <span className="float-right text-primary-500">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Edit */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                title="编辑"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </Button>

              {/* Delete */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeTask(task.id)}
                className="hover:text-red-500 dark:hover:text-red-400"
                title="删除"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </Button>
            </div>
          </div>
        )}

        {/* Add tag */}
        {!editing && (
          <div className="mt-2 flex items-center gap-2">
            {addingTag ? (
              <div className="flex gap-1 items-center">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddTag();
                    if (e.key === 'Escape') setAddingTag(false);
                  }}
                  placeholder="输入标签..."
                  className="px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-primary-500 w-28"
                  autoFocus
                />
                <button
                  onClick={handleAddTag}
                  className="text-primary-500 hover:text-primary-600 text-xs font-medium"
                >
                  添加
                </button>
                <button
                  onClick={() => setAddingTag(false)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-gray-400 hover:text-violet-500 dark:hover:text-violet-400 flex items-center gap-1"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                添加标签
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
