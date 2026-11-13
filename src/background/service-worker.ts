import {
  closeDuplicateTabs,
  getSettings,
  groupTabsBySimilarity,
} from '../lib/chrome-actions.ts';
import { extractDomain, getTabUrl, pickGroupColor } from '../lib/tab-utils.ts';

const autoGroupTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function updateBadge() {
  try {
    const settings = await getSettings();
    if (!settings.showBadge) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    if (!win || win.id == null) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    const tabs = await chrome.tabs.query({ windowId: win.id });
    const text = tabs.length > 0 ? String(tabs.length) : '';
    await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    await chrome.action.setBadgeText({ text });
  } catch {
    // Ignore transient window/tab errors during browser startup or shutdown
  }
}

async function maybeAutoGroupTab(tab: chrome.tabs.Tab) {
  try {
    if (!tab || tab.pinned || tab.id == null || tab.windowId == null) return;
    const settings = await getSettings();
    if (!settings.autoGroup) return;

    const url = getTabUrl(tab);
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    const domain = extractDomain(url);
    const winTabs = await chrome.tabs.query({ windowId: tab.windowId });
    const matching = winTabs.filter(
      (t) => !t.pinned && t.id != null && extractDomain(getTabUrl(t)) === domain
    );

    if (matching.length < settings.minGroupSize) return;

    const existingGroups = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existing = existingGroups.find((g) => g.title === domain);

    if (existing) {
      if (tab.groupId !== existing.id) {
        await chrome.tabs.group({ groupId: existing.id, tabIds: [tab.id] });
      }
      return;
    }

    const tabIds = matching.map((t) => t.id as number) as [number, ...number[]];
    const groupId = await chrome.tabs.group({
      tabIds,
      createProperties: { windowId: tab.windowId },
    });
    await chrome.tabGroups.update(groupId, {
      title: domain,
      color: pickGroupColor(domain),
      collapsed: false,
    });
  } catch {
    // Tab may have been closed or moved mid-operation
  }
}

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

chrome.tabs.onAttached.addListener(() => {
  updateBadge();
});

chrome.tabs.onDetached.addListener(() => {
  updateBadge();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    updateBadge();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    const existingTimer = autoGroupTimers.get(tabId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      autoGroupTimers.delete(tabId);
      maybeAutoGroupTab(tab);
    }, 250);
    autoGroupTimers.set(tabId, timer);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.tabtidy_settings) {
    updateBadge();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const settings = await getSettings();
  if (command === 'group-by-similarity') {
    await groupTabsBySimilarity('current', {
      collapseGroups: settings.collapseGroups,
      includeStaleInUnnecessary: settings.includeStaleInUnnecessary,
      staleMinutes: settings.staleMinutes,
    });
  } else if (command === 'close-duplicates') {
    await closeDuplicateTabs('current', {
      ignoreHash: settings.ignoreHashForDedup,
    });
  }
  updateBadge();
});

updateBadge();
