import {
  closeDuplicateTabs,
  getSettings,
  groupTabsBySimilarity,
} from '../lib/chrome-actions.ts';
import {
  extractDomain,
  getTabUrl,
  isRestorableUrl,
  pickGroupColor,
  toNonEmptyTabIds,
} from '../lib/tab-utils.ts';

const BADGE_DEBOUNCE_MS = 60;
const AUTO_GROUP_DEBOUNCE_MS = 250;
const BADGE_BG_COLOR = '#2563eb';
const autoGroupTimers = new Map<number, ReturnType<typeof setTimeout>>();
const autoGroupSeq = new Map<number, number>();
const autoGroupWindowLocks = new Map<number, Promise<void>>();
let badgeUpdateTimer: ReturnType<typeof setTimeout> | undefined;
let badgeUpdateSeq = 0;
let lastBadgeColorApplied: string | null = null;

function clearAutoGroupTimer(tabId: number): void {
  const existingTimer = autoGroupTimers.get(tabId);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
    autoGroupTimers.delete(tabId);
  }
}

function bumpAutoGroupSeq(tabId: number): number {
  const next = (autoGroupSeq.get(tabId) ?? 0) + 1;
  autoGroupSeq.set(tabId, next);
  return next;
}

async function withWindowAutoGroupLock(windowId: number, task: () => Promise<void>): Promise<void> {
  const prev = autoGroupWindowLocks.get(windowId) ?? Promise.resolve();
  const next = prev.then(task, task);
  autoGroupWindowLocks.set(windowId, next);
  try {
    await next;
  } finally {
    if (autoGroupWindowLocks.get(windowId) === next) {
      autoGroupWindowLocks.delete(windowId);
    }
  }
}

async function updateBadge(): Promise<void> {
  if (badgeUpdateTimer !== undefined) {
    clearTimeout(badgeUpdateTimer);
    badgeUpdateTimer = undefined;
  }
  const seq = ++badgeUpdateSeq;
  try {
    const settings = await getSettings();
    if (seq !== badgeUpdateSeq) return;
    if (!settings.showBadge) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    if (seq !== badgeUpdateSeq) return;
    if (!win || win.id == null) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    const tabs = await chrome.tabs.query({ windowId: win.id });
    if (seq !== badgeUpdateSeq) return;
    const text = tabs.length > 0 ? String(tabs.length) : '';
    if (lastBadgeColorApplied !== BADGE_BG_COLOR) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR });
      lastBadgeColorApplied = BADGE_BG_COLOR;
    }
    if (seq !== badgeUpdateSeq) return;
    await chrome.action.setBadgeText({ text });
  } catch {
    // Ignore transient window/tab errors during browser startup or shutdown
  }
}

async function maybeAutoGroupTab(snapshotTab: chrome.tabs.Tab, seq: number): Promise<void> {
  const tabId = snapshotTab?.id;
  if (tabId == null) return;

  try {
    if (snapshotTab.pinned || snapshotTab.windowId == null) return;

    const initialUrl = getTabUrl(snapshotTab);
    if (!isRestorableUrl(initialUrl)) return;
    if (extractDomain(initialUrl) === 'その他') return;

    const settings = await getSettings();
    if (!settings.autoGroup || autoGroupSeq.get(tabId) !== seq) return;

    const freshTab =
      typeof chrome.tabs.get === 'function'
        ? await chrome.tabs.get(tabId).catch(() => null)
        : snapshotTab;
    if (!freshTab || freshTab.pinned || freshTab.id == null || freshTab.windowId == null) return;
    if (autoGroupSeq.get(tabId) !== seq) return;

    const url = getTabUrl(freshTab);
    if (!isRestorableUrl(url)) return;

    const domain = extractDomain(url);
    if (domain === 'その他') return;

    const windowId = freshTab.windowId;
    const isIncognito = Boolean(freshTab.incognito);

    await withWindowAutoGroupLock(windowId, async () => {
      if (autoGroupSeq.get(tabId) !== seq) return;

      const winTabs = await chrome.tabs.query({ windowId });
      if (autoGroupSeq.get(tabId) !== seq) return;

      let liveTab: chrome.tabs.Tab | undefined;
      const matchingTabIds: number[] = [];
      for (const t of winTabs) {
        if (t.pinned || t.id == null || Boolean(t.incognito) !== isIncognito) continue;
        const tabUrl = getTabUrl(t);
        if (!isRestorableUrl(tabUrl)) continue;
        if (extractDomain(tabUrl) === domain) {
          matchingTabIds.push(t.id);
          if (t.id === tabId) liveTab = t;
        }
      }

      if (!liveTab || matchingTabIds.length < settings.minGroupSize) return;

      const existingGroups = await chrome.tabGroups.query({ windowId });
      if (autoGroupSeq.get(tabId) !== seq) return;

      const existing = existingGroups.find((g) => g.title === domain);
      if (existing) {
        if (liveTab.groupId !== existing.id) {
          await chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] });
        }
        return;
      }

      const tabIds = toNonEmptyTabIds(matchingTabIds);
      if (!tabIds) return;
      const groupId = await chrome.tabs.group({
        tabIds,
        createProperties: { windowId },
      });
      await chrome.tabGroups.update(groupId, {
        title: domain,
        color: pickGroupColor(domain),
        collapsed: false,
      });
    });
  } catch {
    // Tab may have been closed or moved mid-operation
  } finally {
    if (autoGroupSeq.get(tabId) === seq) {
      autoGroupSeq.delete(tabId);
    }
  }
}

async function handleCommand(command: string): Promise<void> {
  try {
    switch (command) {
      case 'group-by-similarity': {
        const settings = await getSettings();
        await groupTabsBySimilarity('current', {
          minGroupSize: settings.minGroupSize,
          collapseGroups: settings.collapseGroups,
          ignoreHash: settings.ignoreHashForDedup,
          includeStaleInUnnecessary: settings.includeStaleInUnnecessary,
          staleMinutes: settings.staleMinutes,
        });
        break;
      }
      case 'close-duplicates': {
        const settings = await getSettings();
        await closeDuplicateTabs('current', {
          ignoreHash: settings.ignoreHashForDedup,
        });
        break;
      }
      default:
        return;
    }
    await updateBadge();
  } catch {
    // Ignore transient window/tab errors when running keyboard commands
  }
}

function scheduleBadgeUpdate(): void {
  if (badgeUpdateTimer !== undefined) {
    clearTimeout(badgeUpdateTimer);
  }
  badgeUpdateTimer = setTimeout(() => {
    badgeUpdateTimer = undefined;
    void updateBadge();
  }, BADGE_DEBOUNCE_MS);
}

function resetBadgeAndSchedule(): void {
  lastBadgeColorApplied = null;
  scheduleBadgeUpdate();
}

chrome.runtime.onInstalled.addListener(resetBadgeAndSchedule);
chrome.runtime.onStartup.addListener(resetBadgeAndSchedule);
chrome.tabs.onCreated.addListener(scheduleBadgeUpdate);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearAutoGroupTimer(tabId);
  autoGroupSeq.delete(tabId);
  scheduleBadgeUpdate();
});

chrome.tabs.onAttached.addListener(scheduleBadgeUpdate);
chrome.tabs.onDetached.addListener(scheduleBadgeUpdate);
chrome.windows.onRemoved?.addListener(scheduleBadgeUpdate);

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    scheduleBadgeUpdate();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.pinned === true) {
    clearAutoGroupTimer(tabId);
    autoGroupSeq.delete(tabId);
    return;
  }
  if (changeInfo.status === 'complete' || changeInfo.url) {
    clearAutoGroupTimer(tabId);
    const url = getTabUrl(tab);
    if (
      !tab ||
      tab.pinned ||
      tab.windowId == null ||
      !isRestorableUrl(url) ||
      extractDomain(url) === 'その他'
    ) {
      autoGroupSeq.delete(tabId);
      return;
    }
    const seq = bumpAutoGroupSeq(tabId);
    const timer = setTimeout(() => {
      autoGroupTimers.delete(tabId);
      void maybeAutoGroupTab(tab, seq);
    }, AUTO_GROUP_DEBOUNCE_MS);
    autoGroupTimers.set(tabId, timer);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.tabtidy_settings) {
    scheduleBadgeUpdate();
  }
});

chrome.commands.onCommand.addListener((command) => {
  void handleCommand(command);
});

scheduleBadgeUpdate();
