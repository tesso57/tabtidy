import type {
  ExtensionSettings,
  GroupPlan,
  InspectedEntry,
  PageSignals,
  Scope,
  StashedSession,
  TabLike,
  UndoSnapshot,
} from '../types/tab.ts';
import { planSmartOrganize, type ClusterOptions, type UnnecessaryAnalysisOptions } from './content-classifier.ts';
import { findDuplicateTabs, findStaleTabs, getSafeFaviconUrl, getTabUrl } from './tab-utils.ts';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  autoGroup: false,
  minGroupSize: 2,
  collapseGroups: false,
  ignoreHashForDedup: false,
  showBadge: true,
  staleMinutes: 60,
  includeStaleInUnnecessary: true,
};

const STORAGE_KEYS = {
  SETTINGS: 'tabtidy_settings',
  STASHED: 'tabtidy_stashed_sessions',
  UNDO: 'tabtidy_last_closed',
} as const;

export async function getSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const stored = (data[STORAGE_KEYS.SETTINGS] || {}) as Partial<ExtensionSettings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(
  updates: Partial<ExtensionSettings>
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next = { ...current, ...updates };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

export async function queryScopedTabs(
  scope: Scope = 'current'
): Promise<{ tabs: chrome.tabs.Tab[]; currentWindowId: number | null }> {
  if (scope === 'all') {
    const [tabs, currentWin] = await Promise.all([
      chrome.tabs.query({ windowType: 'normal' }),
      chrome.windows.getCurrent(),
    ]);
    return { tabs, currentWindowId: currentWin?.id ?? null };
  }
  const currentWin = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: currentWin.id });
  return { tabs, currentWindowId: currentWin.id ?? null };
}

async function saveUndoSnapshot(tabs: TabLike[]): Promise<void> {
  const restorable = tabs
    .map((t) => ({
      title: t.title || getTabUrl(t),
      url: getTabUrl(t),
      windowId: t.windowId,
    }))
    .filter((t) => t.url && t.url !== 'chrome://newtab/' && t.url !== 'about:blank');

  if (restorable.length === 0) return;

  await chrome.storage.local.set({
    [STORAGE_KEYS.UNDO]: {
      closedAt: Date.now(),
      tabs: restorable,
    } satisfies UndoSnapshot,
  });
}

export async function getUndoSnapshot(): Promise<UndoSnapshot | null> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.UNDO);
  return (data[STORAGE_KEYS.UNDO] as UndoSnapshot | undefined) || null;
}

async function openTabsInCurrentWindow(urls: string[]): Promise<void> {
  const win = await chrome.windows.getCurrent();
  for (const url of urls) {
    await chrome.tabs.create({
      windowId: win.id,
      url,
      active: false,
    });
  }
}

export async function restoreUndoSnapshot(): Promise<number> {
  const snapshot = await getUndoSnapshot();
  if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) {
    return 0;
  }
  await openTabsInCurrentWindow(snapshot.tabs.map((item) => item.url));
  await chrome.storage.local.remove(STORAGE_KEYS.UNDO);
  return snapshot.tabs.length;
}

export async function safeCloseTabs(tabsToClose: TabLike[]): Promise<number> {
  if (!tabsToClose || tabsToClose.length === 0) return 0;

  const byWindow = new Map<number, number[]>();
  for (const tab of tabsToClose) {
    if (tab.pinned || tab.id == null || tab.windowId == null) continue;
    const ids = byWindow.get(tab.windowId);
    if (ids) {
      ids.push(tab.id);
    } else {
      byWindow.set(tab.windowId, [tab.id]);
    }
  }

  let closedCount = 0;
  for (const [windowId, ids] of byWindow.entries()) {
    const allWinTabs = await chrome.tabs.query({ windowId });
    const closeIds = new Set(ids);
    const remaining = allWinTabs.filter((t) => t.id == null || !closeIds.has(t.id));

    if (remaining.length === 0) {
      await chrome.tabs.create({ windowId, active: true });
    }
    await chrome.tabs.remove(ids as [number, ...number[]]);
    closedCount += ids.length;
  }

  return closedCount;
}

async function applyGroupPlansInWindow(
  windowId: number,
  plans: GroupPlan[]
): Promise<{ groupCount: number; tabCount: number }> {
  if (!plans || plans.length === 0) {
    return { groupCount: 0, tabCount: 0 };
  }

  const existingGroups = await chrome.tabGroups.query({ windowId });
  const existingByTitle = new Map<string, chrome.tabGroups.TabGroup>();
  for (const g of existingGroups) {
    if (g.title && !existingByTitle.has(g.title)) {
      existingByTitle.set(g.title, g);
    }
  }

  let groupCount = 0;
  let tabCount = 0;

  for (const plan of plans) {
    if (!plan.tabIds || plan.tabIds.length === 0) continue;
    const tabIds = plan.tabIds as [number, ...number[]];
    const existing = existingByTitle.get(plan.title);
    const groupId = existing
      ? await chrome.tabs.group({ groupId: existing.id, tabIds })
      : await chrome.tabs.group({ tabIds, createProperties: { windowId } });

    await chrome.tabGroups.update(groupId, {
      title: plan.title,
      color: plan.color,
      collapsed: Boolean(plan.collapsed),
    });
    groupCount += 1;
    tabCount += plan.tabIds.length;
  }

  return { groupCount, tabCount };
}

function extractPageSignalsInPage(): PageSignals {
  const title = document.title || '';
  const metaDesc =
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ||
    '';
  const headings = Array.from(document.querySelectorAll('h1, h2'))
    .slice(0, 5)
    .map((el) => (el instanceof HTMLElement ? el.innerText : el.textContent || '').trim())
    .filter(Boolean)
    .join(' ');
  const mainEl = document.querySelector('main, article, [role="main"]') || document.body;
  const rawBody = mainEl instanceof HTMLElement ? mainEl.innerText : mainEl?.textContent || '';
  const bodyText = rawBody.replace(/\s+/g, ' ').trim().slice(0, 600);
  const hasVideo = Boolean(document.querySelector('video'));
  const hasFormDraft = Array.from(
    document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')
  ).some((el) => {
    const val =
      el instanceof HTMLElement && el.isContentEditable
        ? el.innerText
        : (el as HTMLInputElement | HTMLTextAreaElement).value;
    return typeof val === 'string' && val.trim().length >= 8;
  });
  return { title, metaDesc, headings, bodyText, hasFormDraft, hasVideo };
}

async function inspectTabsContent(
  tabs: chrome.tabs.Tab[]
): Promise<{ entries: InspectedEntry[]; inspectedCount: number }> {
  let inspectedCount = 0;
  const canScript = Boolean(chrome.scripting?.executeScript);

  const entries: InspectedEntry[] = await Promise.all(
    tabs.map(async (tab) => {
      const url = getTabUrl(tab);
      const isHttp = url.startsWith('http://') || url.startsWith('https://');
      if (!canScript || !isHttp || tab.discarded || tab.id == null) {
        return { tab, signals: null };
      }

      try {
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 700));
        const execPromise = chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            func: extractPageSignalsInPage,
          })
          .then((results) => (results?.[0]?.result as PageSignals | undefined) ?? null)
          .catch(() => null);

        const signals = await Promise.race([execPromise, timeoutPromise]);
        if (signals) inspectedCount += 1;
        return { tab, signals };
      } catch {
        return { tab, signals: null };
      }
    })
  );

  return { entries, inspectedCount };
}

export async function groupTabsBySimilarity(
  scope: Scope = 'current',
  options: UnnecessaryAnalysisOptions & ClusterOptions = {}
): Promise<{
  groupCount: number;
  tabCount: number;
  unnecessaryCount: number;
  protectedCount: number;
  inspectedCount: number;
}> {
  const { tabs } = await queryScopedTabs(scope);
  const { entries, inspectedCount } = await inspectTabsContent(tabs);

  const byWindow = new Map<number, InspectedEntry[]>();
  for (const entry of entries) {
    const winId = entry.tab.windowId;
    if (winId == null) continue;
    const list = byWindow.get(winId);
    if (list) {
      list.push(entry);
    } else {
      byWindow.set(winId, [entry]);
    }
  }

  let groupCount = 0;
  let tabCount = 0;
  let unnecessaryCount = 0;
  let protectedCount = 0;

  for (const [windowId, winEntries] of byWindow.entries()) {
    const planned = planSmartOrganize(winEntries, options);
    const res = await applyGroupPlansInWindow(windowId, planned.plans);
    groupCount += res.groupCount;
    tabCount += res.tabCount;
    unnecessaryCount += planned.unnecessaryCount;
    protectedCount += planned.protectedCount;
  }

  return { groupCount, tabCount, unnecessaryCount, protectedCount, inspectedCount };
}

export async function ungroupAllTabs(scope: Scope = 'current'): Promise<number> {
  const { tabs } = await queryScopedTabs(scope);
  const groupedIds = tabs
    .filter((t) => !t.pinned && t.groupId != null && t.groupId !== -1 && t.id != null)
    .map((t) => t.id as number);

  if (groupedIds.length === 0) return 0;
  await chrome.tabs.ungroup(groupedIds as [number, ...number[]]);
  return groupedIds.length;
}

export async function closeDuplicateTabs(
  scope: Scope = 'current',
  options: { ignoreHash?: boolean } = {}
): Promise<number> {
  const { tabs } = await queryScopedTabs(scope);
  const { duplicateTabs } = findDuplicateTabs(tabs, options);
  if (duplicateTabs.length === 0) return 0;

  await saveUndoSnapshot(duplicateTabs);
  return safeCloseTabs(duplicateTabs);
}

export async function getStashedSessions(): Promise<StashedSession[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.STASHED);
  const list = data[STORAGE_KEYS.STASHED];
  return Array.isArray(list) ? (list as StashedSession[]) : [];
}

async function saveStashedSessions(sessions: StashedSession[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.STASHED]: sessions.slice(0, 50) });
}

export async function stashTabs(
  tabs: TabLike[],
  label = ''
): Promise<{ session: StashedSession | null; closedCount: number }> {
  const stashable = tabs.filter((t) => {
    if (t.pinned || t.id == null) return false;
    const url = getTabUrl(t);
    return Boolean(url && url !== 'chrome://newtab/' && url !== 'about:blank');
  });

  if (stashable.length === 0) {
    return { session: null, closedCount: 0 };
  }

  const now = new Date();
  const defaultLabel = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} の退避`;

  const session: StashedSession = {
    id: `stash_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: label.trim() || defaultLabel,
    createdAt: Date.now(),
    tabs: stashable.map((t) => ({
      title: t.title || getTabUrl(t),
      url: getTabUrl(t),
      favIconUrl: getSafeFaviconUrl(t.favIconUrl),
    })),
  };

  const sessions = await getStashedSessions();
  sessions.unshift(session);
  await saveStashedSessions(sessions);

  const closedCount = await safeCloseTabs(stashable);
  return { session, closedCount };
}

export async function stashStaleTabs(
  scope: Scope = 'current',
  thresholdMinutes = 60
): Promise<{ session: StashedSession | null; closedCount: number }> {
  const { tabs } = await queryScopedTabs(scope);
  const stale = findStaleTabs(tabs, thresholdMinutes);
  return stashTabs(stale, `古いタブ (${thresholdMinutes}分以上未操作)`);
}

export async function restoreStashedSession(
  sessionId: string,
  options: { newWindow?: boolean; removeAfter?: boolean } = {}
): Promise<number> {
  const { newWindow = false, removeAfter = true } = options;
  const sessions = await getStashedSessions();
  const target = sessions.find((s) => s.id === sessionId);
  if (!target || !Array.isArray(target.tabs) || target.tabs.length === 0) {
    return 0;
  }

  const urls = target.tabs.map((t) => t.url);
  if (newWindow) {
    await chrome.windows.create({ url: urls, focused: true });
  } else {
    await openTabsInCurrentWindow(urls);
  }

  if (removeAfter) {
    await saveStashedSessions(sessions.filter((s) => s.id !== sessionId));
  }

  return target.tabs.length;
}

export async function deleteStashedSession(sessionId: string): Promise<void> {
  const sessions = await getStashedSessions();
  await saveStashedSessions(sessions.filter((s) => s.id !== sessionId));
}
