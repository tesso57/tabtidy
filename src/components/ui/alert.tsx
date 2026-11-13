import * as React from 'react';
import { cn } from '@/lib/utils';

export function Alert({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
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
