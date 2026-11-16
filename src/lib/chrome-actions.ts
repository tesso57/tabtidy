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
import {
  planSmartOrganize,
  type ClusterOptions,
  type UnnecessaryAnalysisOptions,
} from './content-classifier.ts';
import {
  appendToMapList,
  findDuplicateTabs,
  findStaleTabs,
  getSafeFaviconUrl,
  getTabUrl,
  isRestorableUrl,
  isTabGrouped,
  toNonEmptyTabIds,
} from './tab-utils.ts';

export const DEFAULT_SETTINGS = {
  autoGroup: false,
  minGroupSize: 2,
  collapseGroups: false,
  ignoreHashForDedup: false,
  showBadge: true,
  staleMinutes: 60,
  includeStaleInUnnecessary: true,
} as const satisfies ExtensionSettings;

const STORAGE_KEYS = {
  SETTINGS: 'tabtidy_settings',
  STASHED: 'tabtidy_stashed_sessions',
  UNDO: 'tabtidy_last_closed',
} as const;

const MAX_MIN_GROUP_SIZE = 1000;
const MAX_STALE_MINUTES = 10_000_000;
const MAX_STASHED_SESSIONS = 50;
const MAX_STORED_TITLE_LENGTH = 500;
const MAX_STASH_LABEL_LENGTH = 120;

interface LocalStorageSchema {
  readonly [STORAGE_KEYS.SETTINGS]: Partial<ExtensionSettings>;
  readonly [STORAGE_KEYS.STASHED]: readonly StashedSession[];
  readonly [STORAGE_KEYS.UNDO]: UndoSnapshot;
}

function createAsyncLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  return async <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

const withSettingsLock = createAsyncLock();
const withStashLock = createAsyncLock();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readPositiveInt(
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  return isFiniteNumber(value) && value >= 1 ? Math.min(max, Math.floor(value)) : fallback;
}

function readNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function sanitizeSettings(
  raw: unknown,
  fallback: ExtensionSettings = DEFAULT_SETTINGS
): ExtensionSettings {
  if (!isPlainObject(raw)) {
    return { ...fallback };
  }
  return {
    autoGroup: readBoolean(raw.autoGroup, fallback.autoGroup),
    minGroupSize: readPositiveInt(raw.minGroupSize, fallback.minGroupSize, MAX_MIN_GROUP_SIZE),
    collapseGroups: readBoolean(raw.collapseGroups, fallback.collapseGroups),
    ignoreHashForDedup: readBoolean(raw.ignoreHashForDedup, fallback.ignoreHashForDedup),
    showBadge: readBoolean(raw.showBadge, fallback.showBadge),
    staleMinutes: readPositiveInt(raw.staleMinutes, fallback.staleMinutes, MAX_STALE_MINUTES),
    includeStaleInUnnecessary: readBoolean(
      raw.includeStaleInUnnecessary,
      fallback.includeStaleInUnnecessary
    ),
  };
}

function filterTabsByIncognitoScope(
  tabs: readonly chrome.tabs.Tab[],
  currentWin: chrome.windows.Window | null | undefined
): chrome.tabs.Tab[] {
  if (currentWin && typeof currentWin.incognito === 'boolean') {
    const isIncognito = currentWin.incognito;
    return tabs.filter((t) => Boolean(t.incognito) === isIncognito);
  }
  return tabs.filter((t) => t.incognito !== true);
}

export async function getSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get<Partial<LocalStorageSchema>>(STORAGE_KEYS.SETTINGS);
  return sanitizeSettings(data[STORAGE_KEYS.SETTINGS]);
}

export async function saveSettings(
  updates: Partial<ExtensionSettings>
): Promise<ExtensionSettings> {
  return withSettingsLock(async () => {
    const current = await getSettings();
    const next = isPlainObject(updates)
      ? sanitizeSettings({ ...current, ...updates }, current)
      : current;
    await chrome.storage.local.set<LocalStorageSchema>({ [STORAGE_KEYS.SETTINGS]: next });
    return next;
  });
}

export async function queryScopedTabs(
  scope: Scope = 'current'
): Promise<{ tabs: chrome.tabs.Tab[]; currentWindowId: number | null }> {
  if (scope === 'all') {
    const [tabs, currentWin] = await Promise.all([
      chrome.tabs.query({ windowType: 'normal' }),
      chrome.windows.getCurrent().catch(() => null),
    ]);
    return {
      tabs: filterTabsByIncognitoScope(tabs, currentWin),
      currentWindowId: currentWin?.id ?? null,
    };
  }
  const currentWin = await chrome.windows.getCurrent().catch(() => null);
  if (!currentWin || currentWin.id == null) {
    return { tabs: [], currentWindowId: null };
  }
  const tabs = await chrome.tabs.query({ windowId: currentWin.id });
  return {
    tabs: filterTabsByIncognitoScope(tabs, currentWin),
    currentWindowId: currentWin.id,
  };
}

async function saveUndoSnapshot(tabs: readonly TabLike[]): Promise<void> {
  const restorable = tabs.flatMap((t) => {
    if (t.incognito === true) return [];
    const url = getTabUrl(t);
    if (!isRestorableUrl(url)) return [];
    return [
      {
        title: readNonEmptyString(t.title, url).slice(0, MAX_STORED_TITLE_LENGTH),
        url,
        windowId: t.windowId,
      },
    ];
  });

  if (restorable.length === 0) return;

  await chrome.storage.local.set<LocalStorageSchema>({
    [STORAGE_KEYS.UNDO]: {
      closedAt: Date.now(),
      tabs: restorable,
    },
  });
}

export async function getUndoSnapshot(): Promise<UndoSnapshot | null> {
  const data = await chrome.storage.local.get<Partial<LocalStorageSchema>>(STORAGE_KEYS.UNDO);
  const raw: unknown = data[STORAGE_KEYS.UNDO];
  if (
    !isPlainObject(raw) ||
    !isFiniteNumber(raw.closedAt) ||
    raw.closedAt < 0 ||
    !Array.isArray(raw.tabs)
  ) {
    return null;
  }

  const tabs = raw.tabs.flatMap((t) => {
    if (!isPlainObject(t) || typeof t.url !== 'string' || !isRestorableUrl(t.url)) {
      return [];
    }
    return [
      {
        url: t.url,
        title: readNonEmptyString(t.title, t.url).slice(0, MAX_STORED_TITLE_LENGTH),
        ...(isNonNegativeInt(t.windowId) ? { windowId: t.windowId } : {}),
      },
    ];
  });

  return tabs.length > 0 ? { closedAt: raw.closedAt, tabs } : null;
}

async function openTabsInCurrentWindow(urls: readonly string[]): Promise<number> {
  const restorableUrls = urls.filter((url) => isRestorableUrl(url));
  if (restorableUrls.length === 0) return 0;

  let win = await chrome.windows.getCurrent().catch(() => null);
  if (win && win.type && win.type !== 'normal' && typeof chrome.windows.getLastFocused === 'function') {
    win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => win);
  }

  let openedCount = 0;
  for (const url of restorableUrls) {
    try {
      await chrome.tabs.create({
        ...(win?.id != null ? { windowId: win.id } : {}),
        url,
        active: false,
      });
      openedCount += 1;
    } catch {
      // Skip invalid or blocked tab URLs instead of aborting remaining tabs
    }
  }
  return openedCount;
}

export async function restoreUndoSnapshot(): Promise<number> {
  const snapshot = await getUndoSnapshot();
  if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) {
    return 0;
  }
  const restorableUrls = snapshot.tabs
    .map((item) => item.url)
    .filter((url) => isRestorableUrl(url));
  if (restorableUrls.length === 0) {
    await chrome.storage.local.remove<LocalStorageSchema>(STORAGE_KEYS.UNDO);
    return 0;
  }
  const restoredCount = await openTabsInCurrentWindow(restorableUrls);
  if (restoredCount > 0) {
    await chrome.storage.local.remove<LocalStorageSchema>(STORAGE_KEYS.UNDO);
  }
  return restoredCount;
}

export async function safeCloseTabs(tabsToClose: readonly TabLike[]): Promise<number> {
  if (tabsToClose.length === 0) return 0;

  const byWindow = new Map<number, number[]>();
  for (const tab of tabsToClose) {
    if (tab.pinned || tab.id == null || tab.windowId == null) continue;
    appendToMapList(byWindow, tab.windowId, tab.id);
  }

  let closedCount = 0;
  for (const [windowId, ids] of byWindow.entries()) {
    const allWinTabs = await chrome.tabs.query({ windowId });
    const liveUnpinnedIds = new Set<number>();
    for (const t of allWinTabs) {
      if (!t.pinned && t.id != null) {
        liveUnpinnedIds.add(t.id);
      }
    }

    const idsToRemove = [...new Set(ids)].filter((id) => liveUnpinnedIds.has(id));
    if (idsToRemove.length === 0) continue;

    const closeIds = new Set(idsToRemove);
    const remaining = allWinTabs.filter((t) => t.id == null || !closeIds.has(t.id));

    if (remaining.length === 0) {
      await chrome.tabs.create({ windowId, active: true });
    }
    await chrome.tabs.remove(idsToRemove);
    closedCount += idsToRemove.length;
  }

  return closedCount;
}

async function applyGroupPlansInWindow(
  windowId: number,
  plans: readonly GroupPlan[]
): Promise<{ groupCount: number; tabCount: number }> {
  if (plans.length === 0) {
    return { groupCount: 0, tabCount: 0 };
  }

  const [liveWinTabs, existingGroups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);

  const liveUnpinnedIds = new Set<number>();
  for (const t of liveWinTabs) {
    if (!t.pinned && t.id != null) {
      liveUnpinnedIds.add(t.id);
    }
  }

  const existingByTitle = new Map<string, chrome.tabGroups.TabGroup>();
  for (const g of existingGroups) {
    if (g.title && !existingByTitle.has(g.title)) {
      existingByTitle.set(g.title, g);
    }
  }

  const assignedTabIds = new Set<number>();
  let groupCount = 0;
  let tabCount = 0;

  for (const plan of plans) {
    const filteredIds: number[] = [];
    for (const id of plan.tabIds) {
      if (liveUnpinnedIds.has(id) && !assignedTabIds.has(id)) {
        assignedTabIds.add(id);
        filteredIds.push(id);
      }
    }
    const tabIds = toNonEmptyTabIds(filteredIds);
    if (!tabIds) continue;

    const existing = existingByTitle.get(plan.title);
    let groupId: number;
    if (existing) {
      try {
        groupId = await chrome.tabs.group({ groupId: existing.id, tabIds });
      } catch {
        existingByTitle.delete(plan.title);
        groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      }
    } else {
      groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    }

    await chrome.tabGroups.update(groupId, {
      title: plan.title,
      color: plan.color,
      collapsed: Boolean(plan.collapsed),
    });
    groupCount += 1;
    tabCount += tabIds.length;
  }

  return { groupCount, tabCount };
}

const INSPECT_CONCURRENCY = 8;
const INSPECT_TIMEOUT_MS = 700;

function extractPageSignalsInPage(): PageSignals {
  const title = (document.title || '').slice(0, 300);
  const metaDesc = (
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ||
    ''
  ).slice(0, 400);

  const headingParts: string[] = [];
  let headingLen = 0;
  for (const el of document.querySelectorAll('h1, h2')) {
    const text = (el instanceof HTMLElement ? el.innerText : el.textContent || '').trim();
    if (!text) continue;
    headingParts.push(text);
    headingLen += text.length + (headingParts.length > 1 ? 1 : 0);
    if (headingParts.length >= 5 || headingLen >= 400) {
      break;
    }
  }
  const headings = headingParts.join(' ').slice(0, 400);

  const mainEl = document.querySelector('main, article, [role="main"]') || document.body;
  const rawBody = mainEl instanceof HTMLElement ? mainEl.innerText : mainEl?.textContent || '';
  const bodyText = rawBody.replace(/\s+/g, ' ').trim().slice(0, 600);
  const hasVideo = Boolean(document.querySelector('video'));

  let hasFormDraft = false;
  for (const el of document.querySelectorAll(
    'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
  )) {
    const val =
      el instanceof HTMLElement && el.isContentEditable
        ? el.innerText
        : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.value
          : '';
    if (val.trim().length >= 8) {
      hasFormDraft = true;
      break;
    }
  }

  return { title, metaDesc, headings, bodyText, hasFormDraft, hasVideo };
}

function sanitizeSignalText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function sanitizePageSignals(raw: unknown): Partial<PageSignals> | null {
  if (!isPlainObject(raw)) return null;
  return {
    title: sanitizeSignalText(raw.title, 300),
    metaDesc: sanitizeSignalText(raw.metaDesc, 400),
    headings: sanitizeSignalText(raw.headings, 400),
    bodyText: sanitizeSignalText(raw.bodyText, 600),
    hasFormDraft: raw.hasFormDraft === true,
    hasVideo: raw.hasVideo === true,
  };
}

async function inspectTabSignals(tabId: number): Promise<Partial<PageSignals> | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), INSPECT_TIMEOUT_MS);
    });
    const execPromise = chrome.scripting
      .executeScript({
        target: { tabId },
        func: extractPageSignalsInPage,
      })
      .then((results) => sanitizePageSignals(results?.[0]?.result))
      .catch(() => null);

    return await Promise.race([execPromise, timeoutPromise]);
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function inspectTabsContent(
  tabs: readonly chrome.tabs.Tab[]
): Promise<{ entries: InspectedEntry[]; inspectedCount: number }> {
  const canScript = Boolean(chrome.scripting?.executeScript);
  if (!canScript || tabs.length === 0) {
    return {
      entries: tabs.map((tab) => ({ tab, signals: null })),
      inspectedCount: 0,
    };
  }

  const entries: InspectedEntry[] = new Array<InspectedEntry>(tabs.length);
  let nextIndex = 0;
  let inspectedCount = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < tabs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const tab = tabs[index];
      if (!tab) continue;

      const url = getTabUrl(tab);
      if (!isRestorableUrl(url) || tab.discarded || tab.id == null) {
        entries[index] = { tab, signals: null };
        continue;
      }

      const signals = await inspectTabSignals(tab.id);
      if (signals) {
        inspectedCount += 1;
      }
      entries[index] = { tab, signals };
    }
  };

  const workerCount = Math.min(INSPECT_CONCURRENCY, tabs.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return { entries, inspectedCount };
}

export async function groupTabsBySimilarity(
  scope: Scope = 'current',
  options: UnnecessaryAnalysisOptions &
    ClusterOptions & { readonly ignoreHashForDedup?: boolean } = {}
): Promise<{
  groupCount: number;
  tabCount: number;
  unnecessaryCount: number;
  protectedCount: number;
  inspectedCount: number;
}> {
  const normalizedOptions: UnnecessaryAnalysisOptions & ClusterOptions =
    options.ignoreHash === undefined && options.ignoreHashForDedup !== undefined
      ? { ...options, ignoreHash: options.ignoreHashForDedup }
      : options;
  const { tabs } = await queryScopedTabs(scope);
  const { entries, inspectedCount } = await inspectTabsContent(tabs);

  const byWindow = new Map<number, InspectedEntry[]>();
  for (const entry of entries) {
    const winId = entry.tab.windowId;
    if (winId == null) continue;
    appendToMapList(byWindow, winId, entry);
  }

  let groupCount = 0;
  let tabCount = 0;
  let unnecessaryCount = 0;
  let protectedCount = 0;

  for (const [windowId, winEntries] of byWindow.entries()) {
    const planned = planSmartOrganize(winEntries, normalizedOptions);
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
  const groupedIds = toNonEmptyTabIds(
    tabs.flatMap((t) => (!t.pinned && isTabGrouped(t) && t.id != null ? [t.id] : []))
  );

  if (!groupedIds) return 0;
  await chrome.tabs.ungroup(groupedIds);
  return groupedIds.length;
}

export async function closeDuplicateTabs(
  scope: Scope = 'current',
  options: { readonly ignoreHash?: boolean } = {}
): Promise<number> {
  const { tabs } = await queryScopedTabs(scope);
  const { duplicateTabs } = findDuplicateTabs(tabs, options);
  const closable = duplicateTabs.filter((t) => !t.pinned && t.id != null && t.windowId != null);
  if (closable.length === 0) return 0;

  await saveUndoSnapshot(closable);
  return safeCloseTabs(closable);
}

export async function getStashedSessions(): Promise<StashedSession[]> {
  const data = await chrome.storage.local.get<Partial<LocalStorageSchema>>(STORAGE_KEYS.STASHED);
  const rawList: unknown = data[STORAGE_KEYS.STASHED];
  if (!Array.isArray(rawList)) return [];

  const sessions: StashedSession[] = [];
  for (const item of rawList) {
    if (!isPlainObject(item)) continue;
    if (typeof item.id !== 'string' || !item.id) continue;
    if (typeof item.name !== 'string') continue;
    if (!isFiniteNumber(item.createdAt) || item.createdAt < 0 || !Array.isArray(item.tabs)) {
      continue;
    }

    const tabs = item.tabs.flatMap((t) => {
      if (!isPlainObject(t) || typeof t.url !== 'string' || !isRestorableUrl(t.url)) {
        return [];
      }
      return [
        {
          title: readNonEmptyString(t.title, t.url).slice(0, MAX_STORED_TITLE_LENGTH),
          url: t.url,
          favIconUrl: typeof t.favIconUrl === 'string' ? getSafeFaviconUrl(t.favIconUrl) : '',
        },
      ];
    });

    if (tabs.length === 0) continue;

    sessions.push({
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      tabs,
    });
  }

  return sessions;
}

async function saveStashedSessions(sessions: readonly StashedSession[]): Promise<void> {
  await chrome.storage.local.set<LocalStorageSchema>({
    [STORAGE_KEYS.STASHED]: sessions.slice(0, MAX_STASHED_SESSIONS),
  });
}

export async function stashTabs(
  tabs: readonly TabLike[],
  label = ''
): Promise<{ session: StashedSession | null; closedCount: number }> {
  const stashable = tabs.filter((t) => {
    if (t.pinned || t.id == null || t.windowId == null || t.incognito === true) return false;
    return isRestorableUrl(getTabUrl(t));
  });

  if (stashable.length === 0) {
    return { session: null, closedCount: 0 };
  }

  const now = new Date();
  const defaultLabel = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} の退避`;

  const session: StashedSession = {
    id: `stash_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: (label.trim() || defaultLabel).slice(0, MAX_STASH_LABEL_LENGTH),
    createdAt: Date.now(),
    tabs: stashable.map((t) => {
      const tabUrl = getTabUrl(t);
      return {
        title: readNonEmptyString(t.title, tabUrl).slice(0, MAX_STORED_TITLE_LENGTH),
        url: tabUrl,
        favIconUrl: getSafeFaviconUrl(t.favIconUrl),
      };
    }),
  };

  await withStashLock(async () => {
    const sessions = await getStashedSessions();
    sessions.unshift(session);
    await saveStashedSessions(sessions);
  });

  const closedCount = await safeCloseTabs(stashable);
  return { session, closedCount };
}

export async function stashStaleTabs(
  scope: Scope = 'current',
  thresholdMinutes = 60
): Promise<{ session: StashedSession | null; closedCount: number }> {
  const safeThreshold = readPositiveInt(
    thresholdMinutes,
    DEFAULT_SETTINGS.staleMinutes,
    MAX_STALE_MINUTES
  );
  const { tabs } = await queryScopedTabs(scope);
  const stale = findStaleTabs(tabs, safeThreshold);
  return stashTabs(stale, `古いタブ (${safeThreshold}分以上未操作)`);
}

export async function restoreStashedSession(
  sessionId: string,
  options: { readonly newWindow?: boolean; readonly removeAfter?: boolean } = {}
): Promise<number> {
  const { newWindow = false, removeAfter = true } = options;
  const sessions = await getStashedSessions();
  const target = sessions.find((s) => s.id === sessionId);
  if (!target || !Array.isArray(target.tabs) || target.tabs.length === 0) {
    return 0;
  }

  const urls = target.tabs.map((t) => t.url).filter((url) => isRestorableUrl(url));
  if (urls.length === 0) {
    return 0;
  }

  let restoredCount = urls.length;
  if (newWindow) {
    await chrome.windows.create({ url: urls, focused: true });
  } else {
    restoredCount = await openTabsInCurrentWindow(urls);
  }

  if (removeAfter && restoredCount > 0) {
    await withStashLock(async () => {
      const latest = await getStashedSessions();
      await saveStashedSessions(latest.filter((s) => s.id !== sessionId));
    });
  }

  return restoredCount;
}

export async function deleteStashedSession(sessionId: string): Promise<void> {
  await withStashLock(async () => {
    const sessions = await getStashedSessions();
    await saveStashedSessions(sessions.filter((s) => s.id !== sessionId));
  });
}
