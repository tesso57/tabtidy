import {
  Archive,
  Clock,
  CopyMinus,
  Cpu,
  Download,
  ExternalLink,
  Pin,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Ungroup,
  Volume2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  closeDuplicateTabs,
  DEFAULT_SETTINGS,
  deleteStashedSession,
  getSettings,
  getStashedSessions,
  getUndoSnapshot,
  groupTabsBySimilarity,
  queryScopedTabs,
  restoreStashedSession,
  restoreUndoSnapshot,
  safeCloseTabs,
  saveSettings,
  stashStaleTabs,
  stashTabs,
  ungroupAllTabs,
} from '@/lib/chrome-actions';
import {
  detectLocalAiStatus,
  prepareLocalModel,
  type LocalAiStatus,
  type LocalLlmAvailability,
} from '@/lib/local-ai';
import { extractDomain, filterTabs, findStaleTabs, getTabUrl, summarizeTabs } from '@/lib/tab-utils';
import { cn } from '@/lib/utils';
import type {
  ExtensionSettings,
  FilterKind,
  Scope,
  StashedSession,
  UndoSnapshot,
} from '@/types/tab';

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

const STALE_MINUTE_OPTIONS = [
  { value: '30', label: '30分' },
  { value: '60', label: '1時間' },
  { value: '180', label: '3時間' },
  { value: '1440', label: '24時間' },
];

function getLlmStatusMeta(availability: LocalLlmAvailability): {
  label: string;
  variant: 'success' | 'info' | 'warning' | 'secondary';
  hint: string;
} {
  switch (availability) {
    case 'available':
      return {
        label: '利用可能',
        variant: 'success',
        hint: 'Gemini Nano がダウンロード済みで、ブラウザ内で動作可能な状態です。',
      };
    case 'downloadable':
      return {
        label: 'DL可能',
        variant: 'info',
        hint: 'この端末で利用できます。「準備」を押すとモデルをダウンロードします。',
      };
    case 'downloading':
      return {
        label: 'DL中',
        variant: 'warning',
        hint: 'Chrome がバックグラウンドで Gemini Nano をダウンロード中です。',
      };
    case 'unavailable':
      return {
        label: '利用不可',
        variant: 'secondary',
        hint: '端末スペック・空き容量またはポリシーによりローカル LLM を利用できません。',
      };
    case 'error':
      return {
        label: 'エラー',
        variant: 'warning',
        hint: 'モデルのステータス取得中にエラーが発生しました。',
      };
    default:
      return {
        label: '未対応',
        variant: 'secondary',
        hint: 'Prompt API (LanguageModel) が無効です。chrome://flags 等をご確認ください。',
      };
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function App() {
  const [scope, setScope] = useState<Scope>('current');
  const [view, setView] = useState<string>('organize');
  const [filter, setFilter] = useState<FilterKind>('all');
  const [query, setQuery] = useState('');
  const [stashLabel, setStashLabel] = useState('');
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [stashed, setStashed] = useState<StashedSession[]>([]);
  const [undo, setUndo] = useState<UndoSnapshot | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState<LocalAiStatus | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDownloadPct, setAiDownloadPct] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
    }, 2500);
  }, []);

  const refresh = useCallback(async (activeScope: Scope = scope) => {
    const [loadedSettings, scoped, sessions, snapshot] = await Promise.all([
      getSettings(),
      queryScopedTabs(activeScope),
      getStashedSessions(),
      getUndoSnapshot(),
    ]);
    setSettings(loadedSettings);
    setTabs(scoped.tabs);
    setStashed(sessions);
    setUndo(snapshot);
  }, [scope]);

  const refreshAiStatus = useCallback(async () => {
    setAiLoading(true);
    try {
      const next = await detectLocalAiStatus();
      setAiStatus(next);
    } finally {
      setAiLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(scope);
    void refreshAiStatus();
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [refresh, refreshAiStatus, scope]);

  const summary = useMemo(
    () => summarizeTabs(tabs, { ignoreHash: settings.ignoreHashForDedup }),
    [tabs, settings.ignoreHashForDedup]
  );

  const matchedTabs = useMemo(
    () => filterTabs(tabs, { query, filter, duplicateIds: summary.duplicateIds }),
    [tabs, query, filter, summary.duplicateIds]
  );

  const staleTabs = useMemo(
    () => findStaleTabs(tabs, settings.staleMinutes),
    [tabs, settings.staleMinutes]
  );

  const unpinnedCount = useMemo(() => tabs.filter((t) => !t.pinned).length, [tabs]);

  const statsSummary = useMemo(() => {
    const parts = [`${summary.total}タブ`];
    if (summary.duplicates > 0) parts.push(`重複${summary.duplicates}`);
    return parts.join(' · ');
  }, [summary]);

  async function handleScopeChange(nextScope: Scope) {
    setScope(nextScope);
  }

  async function handleUndo() {
    const restored = await restoreUndoSnapshot();
    if (restored > 0) showToast(`${restored}件のタブを復元しました`);
    await refresh();
  }

  async function handleSimilarityOrganize() {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const { groupCount, tabCount, unnecessaryCount } = await groupTabsBySimilarity(
        scope,
        settings
      );
      if (groupCount > 0) {
        const extra = unnecessaryCount > 0 ? `（「不要」${unnecessaryCount}件含む）` : '';
        showToast(`${groupCount}グループ・${tabCount}タブを整理しました${extra}`);
      } else {
        showToast('類似グループや不要タブは見つかりませんでした');
      }
    } finally {
      setIsBusy(false);
      await refresh();
    }
  }

  async function handleDedup() {
    const closed = await closeDuplicateTabs(scope, { ignoreHash: settings.ignoreHashForDedup });
    showToast(closed > 0 ? `${closed}件の重複タブを削除しました` : '重複タブはありませんでした');
    await refresh();
  }

  async function handleUngroup() {
    const count = await ungroupAllTabs(scope);
    showToast(count > 0 ? `${count}件のグループを解除しました` : '解除するグループがありません');
    await refresh();
  }

  async function handleActivateTab(tab: chrome.tabs.Tab) {
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    if (tab.id != null) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    window.close();
  }

  async function handleCloseTab(tab: chrome.tabs.Tab) {
    if (tab.pinned) return;
    await safeCloseTabs([tab]);
    await refresh();
  }

  async function handleStashStale() {
    const { closedCount } = await stashStaleTabs(scope, settings.staleMinutes);
    showToast(closedCount > 0 ? `未操作タブ ${closedCount}件を退避しました` : '対象の未操作タブがありません');
    await refresh();
  }

  async function handleStashAll() {
    const { closedCount } = await stashTabs(tabs, stashLabel);
    setStashLabel('');
    showToast(closedCount > 0 ? `${closedCount}件を退避しました` : '退避できるタブがありません');
    await refresh();
  }

  async function handleRestoreSession(sessionId: string, newWindow: boolean) {
    const count = await restoreStashedSession(sessionId, { newWindow, removeAfter: true });
    showToast(
      newWindow
        ? `${count}件を新しいウィンドウで復元しました`
        : `${count}件のタブを復元しました`
    );
    await refresh();
  }

  async function handleDeleteSession(sessionId: string) {
    await deleteStashedSession(sessionId);
    showToast('退避セッションを削除しました');
    await refresh();
  }

  async function handlePrepareLocalModel() {
    if (aiLoading) return;
    setAiLoading(true);
    setAiDownloadPct(0);
    try {
      const next = await prepareLocalModel((pct) => setAiDownloadPct(pct));
      setAiStatus(next);
      if (next.llm.availability === 'available') {
        showToast('ローカルモデル (Gemini Nano) の準備が完了しました');
      } else {
        showToast(`ローカルモデルの状態: ${getLlmStatusMeta(next.llm.availability).label}`);
      }
    } catch {
      showToast('ローカルモデルの準備に失敗しました');
      await refreshAiStatus();
    } finally {
      setAiDownloadPct(null);
      setAiLoading(false);
    }
  }

  async function updateSetting<K extends keyof ExtensionSettings>(
    key: K,
    value: ExtensionSettings[K],
    toastMsg?: string
  ) {
    await saveSettings({ [key]: value });
    if (toastMsg) showToast(toastMsg);
    await refresh();
  }

  return (
    <div className="flex h-[560px] flex-col bg-background text-foreground">
      <Tabs value={view} onValueChange={setView} className="flex min-h-0 flex-1 flex-col">
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
                  onClick={() => void handleScopeChange(s)}
                  className={cn(
                    'rounded-xs px-2 py-0.5 text-[11px] font-medium transition-all cursor-pointer',
                    scope === s
                      ? 'bg-background text-primary font-semibold shadow-xs'
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
                {summary.total}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="stash">
              <span>退避・設定</span>
              <Badge variant="outline" className="h-4 rounded-full px-1.5 text-[10px]">
                {stashed.length}
              </Badge>
            </TabsTrigger>
          </TabsList>
        </header>

        {undo && undo.tabs?.length > 0 && (
          <div className="px-3.5 pt-2.5">
            <Alert className="border-blue-200 bg-blue-50/80 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100">
              <span>直前に閉じた {undo.tabs.length} 件のタブを復元できます</span>
              <Button variant="link" size="xs" className="h-auto p-0 font-semibold text-primary" onClick={() => void handleUndo()}>
                <RotateCcw className="h-3 w-3" />
                元に戻す
              </Button>
            </Alert>
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-3.5 py-3">
          <TabsContent value="organize" className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden">
            <Button
              size="default"
              disabled={unpinnedCount === 0 || isBusy}
              onClick={() => void handleSimilarityOrganize()}
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
                onClick={() => void handleDedup()}
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
                onClick={() => void handleUngroup()}
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
                onChange={(e) => setQuery(e.target.value)}
                placeholder="タブを検索（タイトル・URL）..."
                className={cn('pl-8', query && 'pr-8')}
              />
              {query && (
                <button
                  type="button"
                  aria-label="検索をクリア"
                  onClick={() => setQuery('')}
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
                  onClick={() => setFilter(item.key)}
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
              {matchedTabs.length === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                  一致するタブはありません
                </li>
              ) : (
                matchedTabs.map((tab) => {
                  const rawUrl = getTabUrl(tab);
                  const iconUrl =
                    tab.favIconUrl &&
                    (tab.favIconUrl.startsWith('http://') || tab.favIconUrl.startsWith('https://'))
                      ? tab.favIconUrl
                      : FALLBACK_FAVICON;
                  const isDup = tab.id != null && summary.duplicateIds.has(tab.id);

                  return (
                    <li
                      key={tab.id ?? rawUrl}
                      onClick={() => void handleActivateTab(tab)}
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
                            <Badge variant="info" className="gap-0.5 shrink-0">
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
                            <Badge variant="secondary" className="gap-0.5 shrink-0">
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
                          void handleCloseTab(tab);
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
          </TabsContent>

          <TabsContent value="stash" className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5">
            <Card>
              <CardHeader>
                <CardTitle className="inline-flex min-w-0 items-center gap-1.5">
                  <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">タブを退避（保存して閉じる）</span>
                </CardTitle>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={staleTabs.length === 0}
                  onClick={() => void handleStashStale()}
                  className="shrink-0"
                >
                  <Clock className="h-3 w-3" />
                  未操作を退避 ({staleTabs.length})
                </Button>
              </CardHeader>
              <CardContent className="flex flex-col gap-2.5">
                <div className="flex items-center gap-1.5">
                  <Input
                    value={stashLabel}
                    onChange={(e) => setStashLabel(e.target.value)}
                    placeholder="メモ（省略可）"
                    maxLength={40}
                  />
                  <Button
                    size="sm"
                    disabled={unpinnedCount === 0}
                    onClick={() => void handleStashAll()}
                    className="shrink-0"
                  >
                    すべて退避
                  </Button>
                </div>

                <ul className="thin-scrollbar flex max-h-36 flex-col gap-1.5 overflow-y-auto">
                  {stashed.length === 0 ? (
                    <li className="py-4 text-center text-xs text-muted-foreground">
                      退避されたセッションはありません
                    </li>
                  ) : (
                    stashed.map((session) => (
                      <li
                        key={session.id}
                        className="flex flex-col gap-1 rounded-md border border-border bg-background p-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold">
                            {session.name} ({session.tabs.length}件)
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                            {formatTime(session.createdAt)}
                          </span>
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {session.tabs
                            .slice(0, 3)
                            .map((t) => t.title || t.url)
                            .join(' / ')}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => void handleRestoreSession(session.id, false)}
                          >
                            ここに復元
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => void handleRestoreSession(session.id, true)}
                          >
                            <ExternalLink className="h-3 w-3" />
                            別窓で復元
                          </Button>
                          <Button
                            variant="destructive"
                            size="xs"
                            onClick={() => void handleDeleteSession(session.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                            削除
                          </Button>
                        </div>
                      </li>
                    ))
                  )}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>設定</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col">
                <div className="flex min-h-[36px] items-center justify-between gap-2 border-b border-border pb-2">
                  <label htmlFor="setting-include-stale" className="cursor-pointer text-xs">
                    未操作タブも「不要」に入れる
                  </label>
                  <Switch
                    id="setting-include-stale"
                    checked={settings.includeStaleInUnnecessary}
                    onCheckedChange={(v) => void updateSetting('includeStaleInUnnecessary', v)}
                  />
                </div>

                <div className="flex min-h-[38px] items-center justify-between gap-2 border-b border-border py-2">
                  <label htmlFor="setting-stale-minutes" className="text-xs">
                    未操作とみなす時間
                  </label>
                  <Select
                    id="setting-stale-minutes"
                    value={String(settings.staleMinutes)}
                    options={STALE_MINUTE_OPTIONS}
                    onValueChange={(v) => void updateSetting('staleMinutes', Number(v))}
                  />
                </div>

                <div className="flex min-h-[36px] items-center justify-between gap-2 border-b border-border py-2">
                  <label htmlFor="setting-collapse-groups" className="cursor-pointer text-xs">
                    グループ化時に折りたたむ
                  </label>
                  <Switch
                    id="setting-collapse-groups"
                    checked={settings.collapseGroups}
                    onCheckedChange={(v) => void updateSetting('collapseGroups', v)}
                  />
                </div>

                <div className="flex min-h-[36px] items-center justify-between gap-2 border-b border-border py-2">
                  <label htmlFor="setting-auto-group" className="cursor-pointer text-xs">
                    新規タブを自動でサイト分類
                  </label>
                  <Switch
                    id="setting-auto-group"
                    checked={settings.autoGroup}
                    onCheckedChange={(v) =>
                      void updateSetting(
                        'autoGroup',
                        v,
                        v ? '自動グループ化を有効にしました' : '自動グループ化を無効にしました'
                      )
                    }
                  />
                </div>

                <div className="flex min-h-[36px] items-center justify-between gap-2 border-b border-border py-2">
                  <label htmlFor="setting-ignore-hash" className="cursor-pointer text-xs">
                    重複判定で #以降を無視
                  </label>
                  <Switch
                    id="setting-ignore-hash"
                    checked={settings.ignoreHashForDedup}
                    onCheckedChange={(v) => void updateSetting('ignoreHashForDedup', v)}
                  />
                </div>

                <div className="flex min-h-[36px] items-center justify-between gap-2 pt-2">
                  <label htmlFor="setting-show-badge" className="cursor-pointer text-xs">
                    アイコンにタブ数を表示
                  </label>
                  <Switch
                    id="setting-show-badge"
                    checked={settings.showBadge}
                    onCheckedChange={(v) => void updateSetting('showBadge', v)}
                  />
                </div>

                <p className="pt-2 text-[11px] text-muted-foreground">
                  ピン留め・入力中・音声再生中のタブは「不要」に入れません。
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>ローカルモデル状態</span>
                </CardTitle>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={aiLoading}
                  onClick={() => void refreshAiStatus()}
                  className="shrink-0"
                >
                  <RefreshCw className={cn('h-3 w-3', aiLoading && 'animate-spin')} />
                  再確認
                </Button>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {(() => {
                  const llm = aiStatus?.llm;
                  const meta = llm
                    ? getLlmStatusMeta(llm.availability)
                    : {
                        label: '確認中',
                        variant: 'secondary' as const,
                        hint: 'Chrome 内蔵モデルの利用可否を確認しています...',
                      };
                  const canDownload =
                    llm?.availability === 'downloadable' && aiDownloadPct === null;

                  return (
                    <>
                      <div className="flex min-h-[30px] items-center justify-between gap-2 border-b border-border pb-2">
                        <div className="min-w-0">
                          <div className="text-xs font-medium">Chrome 内蔵 LLM (Gemini Nano)</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {llm ? `API: ${llm.apiKind} (${llm.rawStatus})` : '検出中...'}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {canDownload && (
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={aiLoading}
                              onClick={() => void handlePrepareLocalModel()}
                            >
                              <Download className="h-3 w-3" />
                              準備
                            </Button>
                          )}
                          <Badge variant={meta.variant}>
                            {aiDownloadPct !== null ? `DL ${aiDownloadPct}%` : meta.label}
                          </Badge>
                        </div>
                      </div>

                      <div className="flex min-h-[28px] items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-medium">日本語単語分割 (Intl.Segmenter)</div>
                          <div className="text-[11px] text-muted-foreground">
                            現在の類似度グルーピングで使用中
                          </div>
                        </div>
                        <Badge
                          variant={aiStatus?.segmenter.available ? 'success' : 'secondary'}
                          className="shrink-0"
                        >
                          {aiStatus == null
                            ? '確認中'
                            : aiStatus.segmenter.available
                              ? '利用可能'
                              : 'フォールバック'}
                        </Badge>
                      </div>

                      <p className="text-[11px] text-muted-foreground">
                        {llm?.detail ? `${meta.hint} (${llm.detail})` : meta.hint}
                      </p>
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          </TabsContent>
        </main>
      </Tabs>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-3 left-1/2 z-50 max-w-[340px] -translate-x-1/2 truncate rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-50 shadow-lg dark:border-slate-700 dark:bg-slate-800"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
