import type { ChromeGroupColor, FilterKind, TabLike, TabSummary } from '../types/tab.ts';

export const GROUP_COLORS: ChromeGroupColor[] = [
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'pink',
  'purple',
  'red',
  'grey',
];

/**
 * Return the effective URL of a Chrome tab.
 */
export function getTabUrl(tab: TabLike | null | undefined): string {
  if (!tab) return '';
  return tab.url || tab.pendingUrl || '';
}

/**
 * Extract a clean human-readable domain or category label from a URL.
 */
export function extractDomain(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return 'その他';
  }
  try {
    const parsed = new URL(rawUrl);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') {
      return parsed.hostname.replace(/^www\./i, '') || 'その他';
    }
    if (protocol === 'chrome:') return 'Chrome設定';
    if (protocol === 'chrome-extension:') return '拡張機能';
    if (protocol === 'file:') return 'ローカルファイル';
    if (protocol === 'about:' || protocol === 'devtools:' || protocol === 'edge:') {
      return 'システム';
    }
    return 'その他';
  } catch {
    return 'その他';
  }
}

/**
 * Pick a deterministic Chrome tabGroup color for a label or domain name.
 */
export function pickGroupColor(label: string): ChromeGroupColor {
  let hash = 2166136261;
  const str = String(label || '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return GROUP_COLORS[(hash >>> 0) % GROUP_COLORS.length];
}

/**
 * Normalize a URL for duplicate comparison.
 */
export function normalizeUrlForDedup(
  rawUrl: string,
  options: { ignoreHash?: boolean } = {}
): string {
  const { ignoreHash = false } = options;
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  if (!ignoreHash) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const idx = rawUrl.indexOf('#');
    return idx >= 0 ? rawUrl.slice(0, idx) : rawUrl;
  }
}

/**
 * Find duplicate tabs while never marking pinned tabs for closure.
 * Keeps the active tab if present among duplicates, otherwise the leftmost tab.
 */
export function findDuplicateTabs<T extends TabLike>(
  tabs: T[],
  options: { ignoreHash?: boolean } = {}
): { keepTabs: T[]; duplicateTabs: T[] } {
  const byUrl = new Map<string, T[]>();
  for (const tab of tabs) {
    const rawUrl = getTabUrl(tab);
    const key = normalizeUrlForDedup(rawUrl, options);
    if (!key) continue;
    const bucket = byUrl.get(key);
    if (bucket) {
      bucket.push(tab);
    } else {
      byUrl.set(key, [tab]);
    }
  }

  const keepTabs: T[] = [];
  const duplicateTabs: T[] = [];

  for (const group of byUrl.values()) {
    if (group.length <= 1) {
      if (group.length === 1) keepTabs.push(group[0]);
      continue;
    }

    const pinned = group.filter((t) => t.pinned);
    const unpinned = group.filter((t) => !t.pinned);

    if (pinned.length > 0) {
      keepTabs.push(...pinned);
      duplicateTabs.push(...unpinned);
      continue;
    }

    const sorted = [...unpinned].sort((a, b) => {
      if (Boolean(a.active) !== Boolean(b.active)) {
        return a.active ? -1 : 1;
      }
      return (a.index ?? 0) - (b.index ?? 0);
    });

    keepTabs.push(sorted[0]);
    duplicateTabs.push(...sorted.slice(1));
  }

  return { keepTabs, duplicateTabs };
}

/**
 * Filter tabs by search tokens and category filter.
 */
export function filterTabs<T extends TabLike>(
  tabs: T[],
  options: { query?: string; filter?: FilterKind; duplicateIds?: Set<number> } = {}
): T[] {
  const { query = '', filter = 'all', duplicateIds = new Set<number>() } = options;
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return tabs.filter((tab) => {
    if (filter === 'duplicates' && (tab.id == null || !duplicateIds.has(tab.id))) return false;
    if (filter === 'audible' && !tab.audible) return false;
    if (filter === 'ungrouped') {
      const isGrouped = tab.groupId != null && tab.groupId !== -1;
      if (tab.pinned || isGrouped) return false;
    }

    if (tokens.length === 0) return true;
    const haystack = `${tab.title || ''} ${getTabUrl(tab)}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Find inactive tabs older than thresholdMinutes (excluding pinned, active, and audible tabs).
 */
export function findStaleTabs<T extends TabLike>(
  tabs: T[],
  thresholdMinutes = 60,
  nowMs = Date.now()
): T[] {
  const cutoffMs = Math.max(1, thresholdMinutes) * 60_000;
  return tabs.filter((tab) => {
    if (tab.pinned || tab.active || tab.audible) return false;
    if (typeof tab.lastAccessed !== 'number') return false;
    return nowMs - tab.lastAccessed >= cutoffMs;
  });
}

/**
 * Build summary statistics for a list of tabs.
 */
export function summarizeTabs(
  tabs: TabLike[],
  options: { ignoreHash?: boolean } = {}
): TabSummary {
  const { duplicateTabs } = findDuplicateTabs(tabs, options);
  let pinned = 0;
  let grouped = 0;

  for (const tab of tabs) {
    if (tab.pinned) pinned += 1;
    if (tab.groupId != null && tab.groupId !== -1) grouped += 1;
  }

  const duplicateIds = new Set<number>();
  for (const tab of duplicateTabs) {
    if (tab.id != null) duplicateIds.add(tab.id);
  }

  return {
    total: tabs.length,
    pinned,
    grouped,
    ungrouped: Math.max(0, tabs.length - pinned - grouped),
    duplicates: duplicateTabs.length,
    duplicateIds,
  };
}
