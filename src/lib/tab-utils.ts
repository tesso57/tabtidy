import type { ChromeGroupColor, FilterKind, TabLike, TabSummary } from '../types/tab.ts';

export const GROUP_COLORS = [
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'pink',
  'purple',
  'red',
  'grey',
] as const satisfies readonly ChromeGroupColor[];

const SPECIAL_PROTOCOL_LABELS = new Map<string, string>([
  ['chrome:', 'Chrome設定'],
  ['chrome-extension:', '拡張機能'],
  ['file:', 'ローカルファイル'],
  ['about:', 'システム'],
  ['devtools:', 'システム'],
  ['edge:', 'システム'],
]);

export function appendToMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) {
    bucket.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function isTabGrouped(tab: TabLike): boolean {
  return typeof tab.groupId === 'number' && Number.isFinite(tab.groupId) && tab.groupId >= 0;
}

export function getTabUrl(tab: TabLike | null | undefined): string {
  return tab?.url || tab?.pendingUrl || '';
}

export function parseHttpUrl(rawUrl: unknown): URL | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    const protocol = parsed.protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

export function isRestorableUrl(rawUrl: string): boolean {
  return parseHttpUrl(rawUrl) !== null;
}

export function getSafeFaviconUrl(favIconUrl?: string, fallback = ''): string {
  const parsed = parseHttpUrl(favIconUrl);
  return parsed ? parsed.href : fallback;
}

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
    return SPECIAL_PROTOCOL_LABELS.get(protocol) ?? 'その他';
  } catch {
    return 'その他';
  }
}

/**
 * Chrome's tabs.group / tabs.ungroup require a non-empty tuple.
 */
export function toNonEmptyTabIds(ids: readonly number[]): [number, ...number[]] | null {
  const [first, ...rest] = ids;
  return first !== undefined ? [first, ...rest] : null;
}

export function pickGroupColor(label: string): ChromeGroupColor {
  let hash = 2166136261;
  const str = String(label || '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return GROUP_COLORS[(hash >>> 0) % GROUP_COLORS.length];
}

function normalizeUrlForDedup(
  rawUrl: string,
  options: { readonly ignoreHash?: boolean } = {}
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
 * Never marks pinned tabs as duplicates; when no pinned copy exists,
 * keeps the active tab if present, otherwise the leftmost tab.
 */
export function findDuplicateTabs<T extends TabLike>(
  tabs: readonly T[],
  options: { readonly ignoreHash?: boolean } = {}
): { keepTabs: T[]; duplicateTabs: T[] } {
  const byUrl = new Map<string, T[]>();
  for (const tab of tabs) {
    const key = normalizeUrlForDedup(getTabUrl(tab), options);
    if (!key) continue;
    const dedupKey = `${tab.incognito ? 'i' : 'n'}:${key}`;
    appendToMapList(byUrl, dedupKey, tab);
  }

  const keepTabs: T[] = [];
  const duplicateTabs: T[] = [];

  for (const group of byUrl.values()) {
    if (group.length <= 1) {
      if (group[0]) keepTabs.push(group[0]);
      continue;
    }

    const pinned: T[] = [];
    const unpinned: T[] = [];
    for (const tab of group) {
      (tab.pinned ? pinned : unpinned).push(tab);
    }

    if (pinned.length > 0) {
      keepTabs.push(...pinned);
      duplicateTabs.push(...unpinned);
      continue;
    }

    const sorted = [...unpinned].sort((a, b) => {
      if (Boolean(a.active) !== Boolean(b.active)) {
        return a.active ? -1 : 1;
      }
      const idxA = typeof a.index === 'number' && Number.isFinite(a.index) ? a.index : 0;
      const idxB = typeof b.index === 'number' && Number.isFinite(b.index) ? b.index : 0;
      return idxA - idxB;
    });

    const [kept, ...duplicates] = sorted;
    if (kept) {
      keepTabs.push(kept);
      duplicateTabs.push(...duplicates);
    }
  }

  return { keepTabs, duplicateTabs };
}

export function filterTabs<T extends TabLike>(
  tabs: readonly T[],
  options: {
    readonly query?: string;
    readonly filter?: FilterKind;
    readonly duplicateIds?: ReadonlySet<number>;
  } = {}
): T[] {
  const { query = '', filter = 'all', duplicateIds } = options;
  const trimmed = query.trim().toLowerCase();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];

  return tabs.filter((tab) => {
    if (filter === 'duplicates' && (tab.id == null || !duplicateIds?.has(tab.id))) return false;
    if (filter === 'audible' && !tab.audible) return false;
    if (filter === 'ungrouped' && (tab.pinned || isTabGrouped(tab))) return false;

    if (tokens.length === 0) return true;
    const haystack = `${tab.title || ''} ${getTabUrl(tab)}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export function toStaleCutoffMs(thresholdMinutes = 60): number {
  const minutes =
    Number.isFinite(thresholdMinutes) && thresholdMinutes > 0 ? Math.max(1, thresholdMinutes) : 60;
  return minutes * 60_000;
}

export function findStaleTabs<T extends TabLike>(
  tabs: readonly T[],
  thresholdMinutes = 60,
  nowMs = Date.now()
): T[] {
  const cutoffMs = toStaleCutoffMs(thresholdMinutes);
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  return tabs.filter((tab) => {
    if (tab.pinned || tab.active || tab.audible) return false;
    if (typeof tab.lastAccessed !== 'number' || !Number.isFinite(tab.lastAccessed)) return false;
    return safeNowMs - tab.lastAccessed >= cutoffMs;
  });
}

export function summarizeTabs(
  tabs: readonly TabLike[],
  options: { readonly ignoreHash?: boolean } = {}
): TabSummary {
  const { duplicateTabs } = findDuplicateTabs(tabs, options);
  let pinned = 0;
  let grouped = 0;
  let ungrouped = 0;

  for (const tab of tabs) {
    const isGrouped = isTabGrouped(tab);
    if (tab.pinned) pinned += 1;
    if (isGrouped) {
      grouped += 1;
    } else if (!tab.pinned) {
      ungrouped += 1;
    }
  }

  const duplicateIds = new Set<number>();
  for (const tab of duplicateTabs) {
    if (tab.id != null) duplicateIds.add(tab.id);
  }

  return {
    total: tabs.length,
    pinned,
    grouped,
    ungrouped,
    duplicates: duplicateTabs.length,
    duplicateIds,
  };
}
