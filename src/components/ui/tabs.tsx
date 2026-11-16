import {
  createContext,
  use,
  useId,
  useMemo,
  useRef,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { cn } from '@/lib/utils';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const ctx = use(TabsContext);
  if (!ctx) throw new Error('Tabs components must be used inside <Tabs>');
  return ctx;
}

export interface TabsProps extends ComponentProps<'div'> {
  value: string;
  onValueChange: (value: string) => void;
}

export function Tabs({ value, onValueChange, className, children, ...props }: TabsProps) {
  const baseId = useId();
  const contextValue = useMemo(
    () => ({ value, onValueChange, baseId }),
    [value, onValueChange, baseId]
  );

  return (
    <TabsContext value={contextValue}>
      <div className={cn('flex flex-col', className)} {...props}>
        {children}
      </div>
    </TabsContext>
  );
}

export function TabsList({ className, onKeyDown, ...props }: ComponentProps<'div'>) {
  const ctx = useTabsContext();
  const listRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (
      e.key !== 'ArrowLeft' &&
      e.key !== 'ArrowRight' &&
      e.key !== 'Home' &&
      e.key !== 'End'
    ) {
      return;
    }

    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])') ?? []
    );
    if (tabs.length === 0) return;

    const currentIdx = tabs.findIndex((el) => el === document.activeElement);
    let nextIdx = 0;
    if (e.key === 'ArrowRight') {
      nextIdx = currentIdx >= 0 ? (currentIdx + 1) % tabs.length : 0;
    } else if (e.key === 'ArrowLeft') {
      nextIdx = currentIdx >= 0 ? (currentIdx - 1 + tabs.length) % tabs.length : tabs.length - 1;
    } else if (e.key === 'End') {
      nextIdx = tabs.length - 1;
    }

    const nextTab = tabs[nextIdx];
    const nextValue = nextTab?.dataset.tabValue;
    if (!nextTab || nextValue === undefined) return;
    e.preventDefault();
    nextTab.focus();
    if (nextValue !== ctx.value) {
      ctx.onValueChange(nextValue);
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={handleKeyDown}
      className={cn(
        'grid h-8 w-full grid-cols-2 items-center gap-1 rounded-lg bg-muted p-0.5 text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}

export interface TabsTriggerProps extends ComponentProps<'button'> {
  value: string;
}

export function TabsTrigger({ value, className, ...props }: TabsTriggerProps) {
  const ctx = useTabsContext();
  const isActive = ctx.value === value;
  return (
    <button
      id={`${ctx.baseId}-tab-${value}`}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={`${ctx.baseId}-panel-${value}`}
      tabIndex={isActive ? 0 : -1}
      data-state={isActive ? 'active' : 'inactive'}
      data-tab-value={value}
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'bg-background text-foreground font-semibold shadow-xs'
          : 'text-muted-foreground hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

export interface TabsContentProps extends ComponentProps<'div'> {
  value: string;
}

export function TabsContent({ value, className, ...props }: TabsContentProps) {
  const ctx = useTabsContext();
  if (ctx.value !== value) return null;
  return (
    <div
      id={`${ctx.baseId}-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`${ctx.baseId}-tab-${value}`}
      className={cn('min-h-0 flex-1', className)}
      {...props}
    />
  );
}
