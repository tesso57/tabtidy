import { Badge } from '@/components/ui/badge';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { Scope } from '@/types/tab';

interface PopupHeaderProps {
  statsSummary: string;
  scope: Scope;
  totalTabs: number;
  stashedCount: number;
  onScopeChange: (scope: Scope) => void;
}

export function PopupHeader({
  statsSummary,
  scope,
  totalTabs,
  stashedCount,
  onScopeChange,
}: PopupHeaderProps) {
  return (
    <header className="flex flex-col gap-2.5 border-b border-border bg-gradient-to-b from-blue-50/70 to-background px-3.5 pt-3 pb-2.5 dark:from-blue-950/25 dark:to-background">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <img src="/icons/icon32.png" alt="" className="h-5 w-5 shrink-0 rounded-sm" />
          <span className="text-sm font-semibold tracking-tight text-foreground">TabTidy</span>
          <span className="truncate text-[11px] font-medium text-muted-foreground tabular-nums">
            {statsSummary}
          </span>
        </div>

        <div
          className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted p-0.5"
          role="group"
          aria-label="対象範囲"
        >
          {(['current', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onScopeChange(s)}
              className={cn(
                'rounded-xs px-2 py-0.5 text-[11px] font-medium transition-all cursor-pointer',
                scope === s
                  ? 'bg-background font-semibold text-primary shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {s === 'current' ? '現在' : 'すべて'}
            </button>
          ))}
        </div>
      </div>

      <TabsList>
        <TabsTrigger value="organize">
          <span>整理・タブ</span>
          <Badge variant="outline" className="h-4 rounded-full px-1.5 text-[10px]">
            {totalTabs}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="stash">
          <span>退避・設定</span>
          <Badge variant="outline" className="h-4 rounded-full px-1.5 text-[10px]">
            {stashedCount}
          </Badge>
        </TabsTrigger>
      </TabsList>
    </header>
  );
}
