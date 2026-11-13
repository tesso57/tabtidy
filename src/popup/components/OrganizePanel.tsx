import { CopyMinus, Pin, Search, Sparkles, Ungroup, Volume2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { extractDomain, getSafeFaviconUrl, getTabUrl } from '@/lib/tab-utils';
import { cn } from '@/lib/utils';
import type { FilterKind, TabSummary } from '@/types/tab';

const FALLBACK_FAVICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="#94a3b8" stroke-width="1.3"/><path d="M1.5 5.5h13" stroke="#94a3b8" stroke-width="1.3"/></svg>'
  );

const FILTER_ITEMS: Array<{ key: FilterKind; label: string }> = [
  { key: 'all', label: 'すべて' },
  { key: 'duplicates', label: '重複' },
  { key: 'ungrouped', label: '未グループ' },
  { key: 'audible', label: '再生中' },
];

interface OrganizePanelProps {
  tabs: chrome.tabs.Tab[];
  summary: TabSummary;
  unpinnedCount: number;
  isBusy: boolean;
  query: string;
  filter: FilterKind;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: FilterKind) => void;
  onSimilarityOrganize: () => void;
  onDedup: () => void;
  onUngroup: () => void;
  onActivateTab: (tab: chrome.tabs.Tab) => void;
  onCloseTab: (tab: chrome.tabs.Tab) => void;
}

export function OrganizePanel({
  tabs,
  summary,
  unpinnedCount,
  isBusy,
  query,
  filter,
  onQueryChange,
  onFilterChange,
  onSimilarityOrganize,
  onDedup,
  onUngroup,
  onActivateTab,
  onCloseTab,
}: OrganizePanelProps) {
  return (
    <>
      <Button
        size="default"
        disabled={unpinnedCount === 0 || isBusy}
        onClick={onSimilarityOrganize}
        className="h-10 w-full justify-between bg-gradient-to-r from-blue-600 to-indigo-600 px-3 font-semibold text-white shadow-sm shadow-blue-600/20 hover:from-blue-600/95 hover:to-indigo-600/95 dark:from-blue-600 dark:to-indigo-500"
      >
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          <span>類似度で整理</span>
        </span>
        <span className="rounded-full bg-white/18 px-2 py-0.5 text-[10px] font-medium text-white">
          {isBusy ? '解析中...' : '不要も自動仕分け'}
        </span>
      </Button>

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={summary.duplicates === 0}
          onClick={onDedup}
          className="justify-between px-2.5"
        >
          <span className="inline-flex items-center gap-1.5">
            <CopyMinus className="h-3.5 w-3.5 text-muted-foreground" />
            <span>重複を削除</span>
          </span>
          <Badge variant={summary.duplicates > 0 ? 'warning' : 'secondary'}>
            {summary.duplicates}
          </Badge>
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={summary.grouped === 0}
          onClick={onUngroup}
          className="justify-between px-2.5"
        >
          <span className="inline-flex items-center gap-1.5">
            <Ungroup className="h-3.5 w-3.5 text-muted-foreground" />
            <span>グループ解除</span>
          </span>
          <Badge variant="secondary">{summary.grouped}</Badge>
        </Button>
      </div>

      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="タブを検索（タイトル・URL）..."
          className={cn('pl-8', query && 'pr-8')}
        />
        {query && (
          <button
            type="button"
            aria-label="検索をクリア"
            onClick={() => onQueryChange('')}
            className="absolute right-2 inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="タブ絞り込み">
        {FILTER_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onFilterChange(item.key)}
            className={cn(
              'inline-flex h-6 items-center justify-center rounded-full border px-2.5 text-[11px] font-medium transition-colors cursor-pointer',
              filter === item.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <ul className="thin-scrollbar min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card">
        {tabs.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            一致するタブはありません
          </li>
        ) : (
          tabs.map((tab) => {
            const rawUrl = getTabUrl(tab);
            const iconUrl = getSafeFaviconUrl(tab.favIconUrl, FALLBACK_FAVICON);
            const isDup = tab.id != null && summary.duplicateIds.has(tab.id);

            return (
              <li
                key={tab.id ?? rawUrl}
                onClick={() => onActivateTab(tab)}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 border-b border-border px-2.5 py-2 transition-colors last:border-b-0 hover:bg-accent/70',
                  tab.active && 'border-l-2 border-l-primary bg-blue-50/75 dark:bg-blue-950/35'
                )}
              >
                <img
                  src={iconUrl}
                  alt=""
                  className="h-4 w-4 shrink-0 rounded-xs object-contain"
                  onError={(e) => {
                    if (e.currentTarget.src !== FALLBACK_FAVICON) {
                      e.currentTarget.src = FALLBACK_FAVICON;
                    }
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">
                      {tab.title || rawUrl || '(無題)'}
                    </span>
                    {tab.pinned && (
                      <Badge variant="info" className="shrink-0 gap-0.5">
                        <Pin className="h-2.5 w-2.5" />
                        ピン
                      </Badge>
                    )}
                    {isDup && (
                      <Badge variant="warning" className="shrink-0">
                        重複
                      </Badge>
                    )}
                    {tab.audible && (
                      <Badge variant="secondary" className="shrink-0 gap-0.5">
                        <Volume2 className="h-2.5 w-2.5" />
                        再生中
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {extractDomain(rawUrl)} · {rawUrl}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={Boolean(tab.pinned)}
                  title={tab.pinned ? 'ピン留めタブは保護されています' : 'タブを閉じる'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab);
                  }}
                  className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })
        )}
      </ul>
    </>
  );
}
