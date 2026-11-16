import { AlertCircle, RotateCcw, X } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
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
  const deferredQuery = useDeferredValue(query);
  const [stashLabel, setStashLabel] = useState('');
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [stashed, setStashed] = useState<StashedSession[]>([]);
  const [undo, setUndo] = useState<UndoSnapshot | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const isBusyRef = useRef(false);
  const actionBusyRef = useRef(false);
  const closingTabIdsRef = useRef<Set<number>>(new Set());
  const aiBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const refreshSeqRef = useRef(0);
  const aiSeqRef = useRef(0);
  const scopeRef = useRef<Scope>(scope);
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const settingsPendingRef = useRef(0);
  const [aiStatus, setAiStatus] = useState<LocalAiStatus | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDownloadPct, setAiDownloadPct] = useState<number | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setToast(null);
    }, 2500);
  }, []);

  const showError = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setErrorBanner(message);
  }, []);

  const handleDismissError = useCallback(() => {
    setErrorBanner(null);
  }, []);

  const refresh = useCallback(
    async (activeScope: Scope = scopeRef.current) => {
      const seq = ++refreshSeqRef.current;
      try {
        const [loadedSettings, scoped, sessions, snapshot] = await Promise.all([
          getSettings(),
          queryScopedTabs(activeScope),
          getStashedSessions(),
          getUndoSnapshot(),
        ]);
        if (!mountedRef.current || seq !== refreshSeqRef.current) return;
        if (settingsPendingRef.current === 0) {
          setSettings(loadedSettings);
        }
        setTabs(scoped.tabs);
        setStashed(sessions);
        setUndo(snapshot);
      } catch {
        if (!mountedRef.current || seq !== refreshSeqRef.current) return;
        showError('タブ情報の取得に失敗しました');
      }
    },
    [showError]
  );

  const refreshAiStatus = useCallback(async () => {
    if (aiBusyRef.current) return;
    const seq = ++aiSeqRef.current;
    aiBusyRef.current = true;
    setAiLoading(true);
    setAiError(null);
    try {
      const next = await detectLocalAiStatus();
      if (!mountedRef.current || seq !== aiSeqRef.current) return;
      setAiStatus(next);
      if (next.llm.availability === 'error') {
        setAiError(next.llm.detail || 'ローカルモデル状態の確認中にエラーが発生しました');
      }
    } catch {
      if (!mountedRef.current || seq !== aiSeqRef.current) return;
      const msg = 'ローカルモデル状態の確認に失敗しました';
      setAiError(msg);
      showError(msg);
    } finally {
      aiBusyRef.current = false;
      if (mountedRef.current) setAiLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    scopeRef.current = scope;
    void refresh(scope);
  }, [refresh, scope]);

  useEffect(() => {
    void refreshAiStatus();
  }, [refreshAiStatus]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (!mountedRef.current || isBusyRef.current || actionBusyRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!mountedRef.current || isBusyRef.current || actionBusyRef.current) return;
        void refresh(scopeRef.current);
      }, 120);
    };

    const handleTabUpdated = (_tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
      if (
        changeInfo.status === 'complete' ||
        changeInfo.title !== undefined ||
        changeInfo.url !== undefined ||
        changeInfo.pinned !== undefined ||
        changeInfo.audible !== undefined ||
        changeInfo.groupId !== undefined ||
        changeInfo.favIconUrl !== undefined
      ) {
        scheduleRefresh();
      }
    };

    const handleStorageChanged = (
      _changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName === 'local' && settingsPendingRef.current === 0) {
        scheduleRefresh();
      }
    };

    chrome.tabs?.onCreated?.addListener(scheduleRefresh);
    chrome.tabs?.onRemoved?.addListener(scheduleRefresh);
    chrome.tabs?.onMoved?.addListener(scheduleRefresh);
    chrome.tabs?.onAttached?.addListener(scheduleRefresh);
    chrome.tabs?.onDetached?.addListener(scheduleRefresh);
    chrome.tabs?.onActivated?.addListener(scheduleRefresh);
    chrome.tabs?.onUpdated?.addListener(handleTabUpdated);
    chrome.tabGroups?.onCreated?.addListener(scheduleRefresh);
    chrome.tabGroups?.onUpdated?.addListener(scheduleRefresh);
    chrome.tabGroups?.onRemoved?.addListener(scheduleRefresh);
    chrome.storage?.onChanged?.addListener(handleStorageChanged);

    return () => {
      if (timer) clearTimeout(timer);
      chrome.tabs?.onCreated?.removeListener(scheduleRefresh);
      chrome.tabs?.onRemoved?.removeListener(scheduleRefresh);
      chrome.tabs?.onMoved?.removeListener(scheduleRefresh);
      chrome.tabs?.onAttached?.removeListener(scheduleRefresh);
      chrome.tabs?.onDetached?.removeListener(scheduleRefresh);
      chrome.tabs?.onActivated?.removeListener(scheduleRefresh);
      chrome.tabs?.onUpdated?.removeListener(handleTabUpdated);
      chrome.tabGroups?.onCreated?.removeListener(scheduleRefresh);
      chrome.tabGroups?.onUpdated?.removeListener(scheduleRefresh);
      chrome.tabGroups?.onRemoved?.removeListener(scheduleRefresh);
      chrome.storage?.onChanged?.removeListener(handleStorageChanged);
    };
  }, [refresh]);

  const summary = useMemo(
    () => summarizeTabs(tabs, { ignoreHash: settings.ignoreHashForDedup }),
    [tabs, settings.ignoreHashForDedup]
  );

  const matchedTabs = useMemo(
    () => filterTabs(tabs, { query: deferredQuery, filter, duplicateIds: summary.duplicateIds }),
    [tabs, deferredQuery, filter, summary.duplicateIds]
  );

  const staleCount = useMemo(
    () => (view === 'stash' ? findStaleTabs(tabs, settings.staleMinutes).length : 0),
    [view, tabs, settings.staleMinutes]
  );

  const unpinnedCount = summary.total - summary.pinned;

  const statsSummary = useMemo(() => {
    const parts = [`${summary.total}タブ`];
    if (summary.duplicates > 0) parts.push(`重複${summary.duplicates}`);
    return parts.join(' · ');
  }, [summary]);

  const runTabAction = useCallback(
    async <T,>(
      action: () => Promise<T>,
      options: {
        errorMessage: string;
        successMessage?: string | ((result: T) => string | null | undefined);
        refreshAfter?: 'success' | 'always';
        lockBusy?: boolean;
      }
    ) => {
      const { errorMessage, successMessage, refreshAfter = 'success', lockBusy = false } = options;
      if (isBusyRef.current || actionBusyRef.current) return;
      actionBusyRef.current = true;
      if (lockBusy) {
        isBusyRef.current = true;
        setIsBusy(true);
      }
      if (mountedRef.current) setErrorBanner(null);
      let succeeded = false;
      try {
        const result = await action();
        succeeded = true;
        const message =
          typeof successMessage === 'function' ? successMessage(result) : successMessage;
        if (message) showToast(message);
      } catch {
        showError(errorMessage);
      } finally {
        actionBusyRef.current = false;
        if (lockBusy) {
          isBusyRef.current = false;
          if (mountedRef.current) setIsBusy(false);
        }
        if (mountedRef.current && (refreshAfter === 'always' || (refreshAfter === 'success' && succeeded))) {
          await refresh();
        }
      }
    },
    [refresh, showError, showToast]
  );

  const handleUndo = useCallback(() => {
    void runTabAction(() => restoreUndoSnapshot(), {
      successMessage: (restored) => (restored > 0 ? `${restored}件のタブを復元しました` : null),
      errorMessage: 'タブの復元に失敗しました',
    });
  }, [runTabAction]);

  const handleSimilarityOrganize = useCallback(() => {
    void runTabAction(() => groupTabsBySimilarity(scope, settings), {
      lockBusy: true,
      refreshAfter: 'always',
      successMessage: ({ groupCount, tabCount, unnecessaryCount }) => {
        if (groupCount === 0) return '類似グループや不要タブは見つかりませんでした';
        const extra = unnecessaryCount > 0 ? `（「不要」${unnecessaryCount}件含む）` : '';
        return `${groupCount}グループ・${tabCount}タブを整理しました${extra}`;
      },
      errorMessage: 'タブの整理に失敗しました',
    });
  }, [runTabAction, scope, settings]);

  const handleDedup = useCallback(() => {
    void runTabAction(() => closeDuplicateTabs(scope, { ignoreHash: settings.ignoreHashForDedup }), {
      successMessage: (closed) =>
        closed > 0 ? `${closed}件の重複タブを削除しました` : '重複タブはありませんでした',
      errorMessage: '重複タブの削除に失敗しました',
    });
  }, [runTabAction, scope, settings.ignoreHashForDedup]);

  const handleUngroup = useCallback(() => {
    void runTabAction(() => ungroupAllTabs(scope), {
      successMessage: (count) =>
        count > 0 ? `${count}件のグループを解除しました` : '解除するグループがありません',
      errorMessage: 'グループの解除に失敗しました',
    });
  }, [runTabAction, scope]);

  const handleActivateTab = useCallback(
    (tab: chrome.tabs.Tab) => {
      if (isBusyRef.current || actionBusyRef.current) return;
      actionBusyRef.current = true;
      void (async () => {
        if (mountedRef.current) setErrorBanner(null);
        try {
          if (tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          if (tab.id != null) {
            await chrome.tabs.update(tab.id, { active: true });
          }
          window.close();
        } catch {
          showError('タブの切り替えに失敗しました');
          if (mountedRef.current) await refresh();
        } finally {
          actionBusyRef.current = false;
        }
      })();
    },
    [refresh, showError]
  );

  const handleCloseTab = useCallback(
    (tab: chrome.tabs.Tab) => {
      if (tab.pinned || isBusyRef.current) return;
      const tabId = tab.id;
      if (tabId != null) {
        if (closingTabIdsRef.current.has(tabId)) return;
        closingTabIdsRef.current.add(tabId);
      }
      void (async () => {
        if (mountedRef.current) setErrorBanner(null);
        try {
          await safeCloseTabs([tab]);
        } catch {
          showError('タブを閉じられませんでした');
        } finally {
          if (tabId != null) closingTabIdsRef.current.delete(tabId);
          if (mountedRef.current) await refresh();
        }
      })();
    },
    [refresh, showError]
  );

  const handleStashStale = useCallback(() => {
    void runTabAction(() => stashStaleTabs(scope, settings.staleMinutes), {
      successMessage: ({ closedCount }) =>
        closedCount > 0 ? `未操作タブ ${closedCount}件を退避しました` : '対象の未操作タブがありません',
      errorMessage: '未操作タブの退避に失敗しました',
    });
  }, [runTabAction, scope, settings.staleMinutes]);

  const handleStashAll = useCallback(() => {
    void runTabAction(
      async () => {
        const result = await stashTabs(tabs, stashLabel);
        if (result.closedCount > 0 && mountedRef.current) {
          setStashLabel('');
        }
        return result;
      },
      {
        successMessage: ({ closedCount }) =>
          closedCount > 0 ? `${closedCount}件を退避しました` : '退避できるタブがありません',
        errorMessage: 'タブの退避に失敗しました',
      }
    );
  }, [runTabAction, tabs, stashLabel]);

  const handleRestoreSession = useCallback(
    (sessionId: string, newWindow: boolean) => {
      void runTabAction(() => restoreStashedSession(sessionId, { newWindow, removeAfter: true }), {
        successMessage: (count) =>
          newWindow
            ? `${count}件を新しいウィンドウで復元しました`
            : `${count}件のタブを復元しました`,
        errorMessage: 'セッションの復元に失敗しました',
      });
    },
    [runTabAction]
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      void runTabAction(() => deleteStashedSession(sessionId), {
        successMessage: '退避セッションを削除しました',
        errorMessage: '退避セッションの削除に失敗しました',
      });
    },
    [runTabAction]
  );

  const handleRefreshAiStatus = useCallback(() => {
    void refreshAiStatus();
  }, [refreshAiStatus]);

  const handlePrepareLocalModel = useCallback(() => {
    if (aiBusyRef.current) return;
    const seq = ++aiSeqRef.current;
    aiBusyRef.current = true;
    setAiLoading(true);
    setAiDownloadPct(0);
    setAiError(null);
    void (async () => {
      try {
        const next = await prepareLocalModel((pct) => {
          if (mountedRef.current && seq === aiSeqRef.current) {
            setAiDownloadPct(pct);
          }
        });
        if (!mountedRef.current || seq !== aiSeqRef.current) return;
        setAiDownloadPct(null);
        setAiStatus(next);
        if (next.llm.availability === 'available') {
          showToast('ローカルモデル (Gemini Nano) の準備が完了しました');
        } else if (next.llm.availability === 'error') {
          const msg = next.llm.detail || 'ローカルモデルの状態確認でエラーが発生しました';
          setAiError(msg);
          showError(msg);
        } else {
          showToast('ローカルモデルの状態を更新しました');
        }
      } catch (err) {
        if (!mountedRef.current || seq !== aiSeqRef.current) return;
        setAiDownloadPct(null);
        const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
        const msg = `ローカルモデルの準備に失敗またはキャンセルされました${detail}`;
        setAiError(msg);
        showError('ローカルモデルの準備に失敗しました');
        try {
          const refreshed = await detectLocalAiStatus();
          if (mountedRef.current && seq === aiSeqRef.current) {
            setAiStatus(refreshed);
          }
        } catch {
          // Keep the prepare failure state visible when re-probing also fails
        }
      } finally {
        aiBusyRef.current = false;
        if (mountedRef.current) {
          setAiDownloadPct(null);
          setAiLoading(false);
        }
      }
    })();
  }, [showError, showToast]);

  const handleUpdateSetting = useCallback(
    <K extends keyof ExtensionSettings>(
      key: K,
      value: ExtensionSettings[K],
      toastMsg?: string
    ) => {
      settingsPendingRef.current += 1;
      setErrorBanner(null);
      setSettings((prev) => ({ ...prev, [key]: value }));
      settingsQueueRef.current = settingsQueueRef.current.then(async () => {
        let failed = false;
        try {
          const next = await saveSettings({ [key]: value });
          if (!mountedRef.current) return;
          if (settingsPendingRef.current === 1) {
            setSettings(next);
          }
          if (toastMsg) showToast(toastMsg);
        } catch {
          failed = true;
          showError('設定の保存に失敗しました');
        } finally {
          settingsPendingRef.current = Math.max(0, settingsPendingRef.current - 1);
        }
        if (failed && mountedRef.current && settingsPendingRef.current === 0) {
          await refresh();
        }
      });
    },
    [refresh, showError, showToast]
  );

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

        {errorBanner && (
          <div className="px-3.5 pt-2.5">
            <Alert className="border-red-200 bg-red-50/90 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 break-words">{errorBanner}</span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="エラーを閉じる"
                onClick={handleDismissError}
                className="h-5 w-5 shrink-0 text-current hover:bg-red-200/50 dark:hover:bg-red-900/40"
              >
                <X className="h-3 w-3" />
              </Button>
            </Alert>
          </div>
        )}

        {undo && Array.isArray(undo.tabs) && undo.tabs.length > 0 && (
          <div className="px-3.5 pt-2.5">
            <Alert className="border-blue-200 bg-blue-50/80 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100">
              <span>直前に閉じた {undo.tabs.length} 件のタブを復元できます</span>
              <Button
                variant="link"
                size="xs"
                disabled={isBusy}
                className="h-auto p-0 font-semibold text-primary"
                onClick={handleUndo}
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
              onSimilarityOrganize={handleSimilarityOrganize}
              onDedup={handleDedup}
              onUngroup={handleUngroup}
              onActivateTab={handleActivateTab}
              onCloseTab={handleCloseTab}
            />
          </TabsContent>

          <TabsContent
            value="stash"
            className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5"
          >
            <StashCard
              stashLabel={stashLabel}
              staleCount={staleCount}
              unpinnedCount={unpinnedCount}
              isBusy={isBusy}
              sessions={stashed}
              onLabelChange={setStashLabel}
              onStashStale={handleStashStale}
              onStashAll={handleStashAll}
              onRestoreSession={handleRestoreSession}
              onDeleteSession={handleDeleteSession}
            />
            <SettingsCard
              settings={settings}
              onUpdateSetting={handleUpdateSetting}
            />
            <LocalAiCard
              status={aiStatus}
              loading={aiLoading}
              downloadPct={aiDownloadPct}
              error={aiError}
              onRefresh={handleRefreshAiStatus}
              onPrepare={handlePrepareLocalModel}
            />
          </TabsContent>
        </main>
      </Tabs>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-3 left-1/2 z-50 w-max max-w-[348px] -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-center text-xs font-medium text-slate-50 shadow-lg break-words dark:border-slate-700 dark:bg-slate-800"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
