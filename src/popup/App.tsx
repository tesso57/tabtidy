import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent } from '@/components/ui/tabs';
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
import { detectLocalAiStatus, prepareLocalModel, type LocalAiStatus } from '@/lib/local-ai';
import { filterTabs, findStaleTabs, summarizeTabs } from '@/lib/tab-utils';
import { LocalAiCard } from '@/popup/components/LocalAiCard';
import { OrganizePanel } from '@/popup/components/OrganizePanel';
import { PopupHeader } from '@/popup/components/PopupHeader';
import { SettingsCard } from '@/popup/components/SettingsCard';
import { StashCard } from '@/popup/components/StashCard';
import type {
  ExtensionSettings,
  FilterKind,
  Scope,
  StashedSession,
  UndoSnapshot,
} from '@/types/tab';

export function App() {
  const [scope, setScope] = useState<Scope>('current');
  const [view, setView] = useState('organize');
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

  const refresh = useCallback(
    async (activeScope: Scope = scope) => {
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
    },
    [scope]
  );

  const refreshAiStatus = useCallback(async () => {
    setAiLoading(true);
    try {
      setAiStatus(await detectLocalAiStatus());
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
    showToast(
      closedCount > 0 ? `未操作タブ ${closedCount}件を退避しました` : '対象の未操作タブがありません'
    );
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
      showToast(
        next.llm.availability === 'available'
          ? 'ローカルモデル (Gemini Nano) の準備が完了しました'
          : 'ローカルモデルの状態を更新しました'
      );
    } catch {
      showToast('ローカルモデルの準備に失敗しました');
      await refreshAiStatus();
    } finally {
      setAiDownloadPct(null);
      setAiLoading(false);
    }
  }

  async function handleUpdateSetting<K extends keyof ExtensionSettings>(
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
        <PopupHeader
          statsSummary={statsSummary}
          scope={scope}
          totalTabs={summary.total}
          stashedCount={stashed.length}
          onScopeChange={setScope}
        />

        {undo && undo.tabs?.length > 0 && (
          <div className="px-3.5 pt-2.5">
            <Alert className="border-blue-200 bg-blue-50/80 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100">
              <span>直前に閉じた {undo.tabs.length} 件のタブを復元できます</span>
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0 font-semibold text-primary"
                onClick={() => void handleUndo()}
              >
                <RotateCcw className="h-3 w-3" />
                元に戻す
              </Button>
            </Alert>
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-3.5 py-3">
          <TabsContent
            value="organize"
            className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden"
          >
            <OrganizePanel
              tabs={matchedTabs}
              summary={summary}
              unpinnedCount={unpinnedCount}
              isBusy={isBusy}
              query={query}
              filter={filter}
              onQueryChange={setQuery}
              onFilterChange={setFilter}
              onSimilarityOrganize={() => void handleSimilarityOrganize()}
              onDedup={() => void handleDedup()}
              onUngroup={() => void handleUngroup()}
              onActivateTab={(tab) => void handleActivateTab(tab)}
              onCloseTab={(tab) => void handleCloseTab(tab)}
            />
          </TabsContent>

          <TabsContent
            value="stash"
            className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5"
          >
            <StashCard
              stashLabel={stashLabel}
              staleCount={staleTabs.length}
              unpinnedCount={unpinnedCount}
              sessions={stashed}
              onLabelChange={setStashLabel}
              onStashStale={() => void handleStashStale()}
              onStashAll={() => void handleStashAll()}
              onRestoreSession={(id, newWin) => void handleRestoreSession(id, newWin)}
              onDeleteSession={(id) => void handleDeleteSession(id)}
            />
            <SettingsCard
              settings={settings}
              onUpdateSetting={(k, v, msg) => void handleUpdateSetting(k, v, msg)}
            />
            <LocalAiCard
              status={aiStatus}
              loading={aiLoading}
              downloadPct={aiDownloadPct}
              onRefresh={() => void refreshAiStatus()}
              onPrepare={() => void handlePrepareLocalModel()}
            />
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
