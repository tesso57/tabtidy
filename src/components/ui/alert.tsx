import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Alert({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-xs text-secondary-foreground',
        className
      )}
      {...props}
    />
  );
}
