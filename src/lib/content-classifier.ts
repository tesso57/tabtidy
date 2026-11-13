import type { GroupPlan, InspectedEntry, PageSignals, TabLike } from '../types/tab.ts';
import { extractDomain, findDuplicateTabs, getTabUrl, pickGroupColor } from './tab-utils.ts';

const JA_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('ja', { granularity: 'word' })
    : null;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'have', 'has', 'not', 'but', 'you', 'your', 'can', 'all', 'more', 'new',
  'about', 'how', 'what', 'when', 'who', 'why', 'http', 'https', 'www', 'com',
  'org', 'net', 'html', 'php', 'jsp', 'page', 'home', 'index', 'login', 'sign',
  '公式', 'ホーム', 'ページ', 'サイト', '一覧', '検索', 'ログイン', '新規', '登録',
  '無料', '利用', '規約', '詳細', '案内', 'メニュー', 'トップ', '最新', '記事',
  'これ', 'それ', 'あれ', 'ため', 'こと', 'もの', 'よう', 'さん', 'する', 'した',
  'して', 'いる', 'ある', 'なる', 'でき', 'できる', 'ます', 'です', 'から', 'まで',
  'より', 'など', 'について', 'まとめ',
  'google', 'yahoo', 'bing', 'microsoft',
]);

const ERROR_PATTERNS = [
  /\b404\b/i,
  /\b500\b/i,
  /\b502\b/i,
  /\b503\b/i,
  /not found/i,
  /page not found/i,
  /this site can['’]t be reached/i,
  /ページが見つかりません/,
  /アクセスできません/,
  /エラーが発生しました/,
];

const AUTH_LEFTOVER_PATTERNS = [
  /oauth\/?callback/i,
  /auth\/?callback/i,
  /認証が完了/,
  /ログインが完了/,
  /サインインしました/,
  /you can close this (tab|window)/i,
  /このウィンドウを閉じて/,
];

const GENERIC_SITE_SUFFIXES = new Set([
  'google', 'youtube', 'wikipedia', 'github', 'qiita', 'zenn', 'note',
  'amazon', 'rakuten', 'yahoo', 'twitter', 'x', 'facebook', 'instagram',
  'slack', 'notion', 'bing', 'microsoft',
]);

/**
 * Tokenize Japanese and English text using Chrome's built-in Intl.Segmenter,
 * with regex fallback.
 */
export function tokenizeText(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const tokens: string[] = [];

  if (JA_SEGMENTER) {
    for (const { segment, isWordLike } of JA_SEGMENTER.segment(text)) {
      if (!isWordLike) continue;
      const normalized = segment.trim().toLowerCase();
      if (normalized.length < 2) continue;
      if (/^\d+$/.test(normalized)) continue;
      if (/^[\u3040-\u309F]{1,2}$/.test(normalized)) continue;
      if (STOP_WORDS.has(normalized)) continue;
      tokens.push(normalized);
    }
    return tokens;
  }

  const lower = text.toLowerCase();
  const enMatches = lower.match(/[a-z0-9][a-z0-9._-]{1,28}/g) || [];
  for (const w of enMatches) {
    const cleaned = w.replace(/^[._-]+|[._-]+$/g, '');
    if (cleaned.length >= 2 && !/^\d+$/.test(cleaned) && !STOP_WORDS.has(cleaned)) {
      tokens.push(cleaned);
    }
  }

  const jaMatches = text.match(/[\u4E00-\u9FFF]{2,12}|[\u30A0-\u30FF]{2,14}/g) || [];
  for (const w of jaMatches) {
    if (!STOP_WORDS.has(w)) {
      tokens.push(w);
    }
  }

  return tokens;
}

/**
 * Strip trailing " - Site Name" / " | Site Name" suffixes from page titles
 * so unrelated pages on the same platform (e.g. Google Calendar vs Google Meet,
 * or two unrelated Wikipedia/YouTube pages) do not merge by brand name alone.
 */
export function stripTrailingSiteSuffix(title: string, url = ''): string {
  if (!title || typeof title !== 'string') return '';
  const match = title.match(/^(.+?)\s+[-|–—·:]\s+([^|\-–—·:]{1,32})$/);
  if (!match) return title;

  const [, mainPart, suffixPart] = match;
  const suffixLower = suffixPart.trim().toLowerCase();
  const domain = extractDomain(url).toLowerCase();
  const domainLabels = domain.split('.').filter((p) => p.length >= 2 && p !== 'co' && p !== 'ne');

  const isSiteSuffix =
    domainLabels.some((label) => suffixLower.includes(label)) ||
    GENERIC_SITE_SUFFIXES.has(suffixLower) ||
    /^(google|yahoo|microsoft)\s+/i.test(suffixLower);

  return isSiteSuffix && mainPart.trim().length > 0 ? mainPart.trim() : title;
}

function buildWeightedTermMap(tab: TabLike, signals: Partial<PageSignals> | null): Map<string, number> {
  const weights = new Map<string, number>();
  const addTokens = (text: string, weight: number) => {
    for (const token of tokenizeText(text)) {
      weights.set(token, (weights.get(token) || 0) + weight);
    }
  };

  const url = getTabUrl(tab);
  const cleanTitle = stripTrailingSiteSuffix(signals?.title || tab.title || '', url);

  addTokens(cleanTitle, 3);
  addTokens(signals?.headings || '', 2.5);
  addTokens(signals?.metaDesc || '', 2);
  addTokens(signals?.bodyText || '', 1);

  return weights;
}

function cosineSimilarity(mapA: Map<string, number>, mapB: Map<string, number>): number {
  if (mapA.size === 0 || mapB.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [k, v] of mapA.entries()) {
    normA += v * v;
    const bVal = mapB.get(k);
    if (bVal) dot += v * bVal;
  }
  for (const v of mapB.values()) {
    normB += v * v;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface UnnecessaryAnalysisOptions {
  staleMinutes?: number;
  ignoreHash?: boolean;
  includeStaleInUnnecessary?: boolean;
  nowMs?: number;
}

/**
 * Separate unnecessary tabs (duplicates, errors, auth leftovers, stale searches, optionally stale tabs)
 * while protecting pinned, active, audible, and form-draft tabs.
 */
export function analyzeUnnecessaryTabs(
  entries: InspectedEntry[],
  options: UnnecessaryAnalysisOptions = {}
): {
  unnecessaryTabs: TabLike[];
  remainingEntries: InspectedEntry[];
  protectedTabs: TabLike[];
} {
  const {
    staleMinutes = 60,
    ignoreHash = false,
    includeStaleInUnnecessary = true,
    nowMs = Date.now(),
  } = options;

  const tabs = entries.map((e) => e.tab);
  const { duplicateTabs } = findDuplicateTabs(tabs, { ignoreHash });
  const duplicateIds = new Set(
    duplicateTabs.map((t) => t.id).filter((id): id is number => id != null)
  );
  const cutoffMs = Math.max(1, staleMinutes) * 60_000;

  const unnecessaryTabs: TabLike[] = [];
  const remainingEntries: InspectedEntry[] = [];
  const protectedTabs: TabLike[] = [];

  for (const entry of entries) {
    const { tab, signals } = entry;
    if (tab.pinned || tab.id == null) continue;

    if (signals?.hasFormDraft || tab.audible) {
      protectedTabs.push(tab);
      remainingEntries.push(entry);
      continue;
    }

    const url = getTabUrl(tab);
    const title = signals?.title || tab.title || '';
    const body = signals?.bodyText || '';
    const textSample = `${title} ${body.slice(0, 250)}`;

    const isError = ERROR_PATTERNS.some(
      (re) => re.test(title) || (body.length < 400 && re.test(textSample))
    );
    const isAuthLeftover = AUTH_LEFTOVER_PATTERNS.some(
      (re) => re.test(url) || re.test(textSample)
    );
    const isStaleSearch =
      !tab.active &&
      typeof tab.lastAccessed === 'number' &&
      nowMs - tab.lastAccessed >= 15 * 60_000 &&
      /google\.[^/]+\/search|bing\.com\/search/i.test(url);
    const isStale =
      includeStaleInUnnecessary &&
      !tab.active &&
      typeof tab.lastAccessed === 'number' &&
      nowMs - tab.lastAccessed >= cutoffMs;

    if (duplicateIds.has(tab.id) || isError || isAuthLeftover || isStaleSearch || isStale) {
      unnecessaryTabs.push(tab);
    } else {
      remainingEntries.push(entry);
    }
  }

  return { unnecessaryTabs, remainingEntries, protectedTabs };
}

export interface ClusterOptions {
  minGroupSize?: number;
  collapseGroups?: boolean;
  similarityThreshold?: number;
}

/**
 * Cluster tabs with similar content across domains and name groups by top shared keywords.
 */
export function clusterTabsByContent(
  entries: InspectedEntry[],
  options: ClusterOptions = {}
): GroupPlan[] {
  const { minGroupSize = 2, collapseGroups = false, similarityThreshold = 0.2 } = options;
  const unpinned = entries.filter((e) => !e.tab.pinned && e.tab.id != null);
  const termMaps = unpinned.map((e) => buildWeightedTermMap(e.tab, e.signals));

  const parent = unpinned.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < unpinned.length; i += 1) {
    for (let j = i + 1; j < unpinned.length; j += 1) {
      if (cosineSimilarity(termMaps[i], termMaps[j]) >= similarityThreshold) {
        union(i, j);
      }
    }
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < unpinned.length; i += 1) {
    const root = find(i);
    const list = components.get(root);
    if (list) {
      list.push(i);
    } else {
      components.set(root, [i]);
    }
  }

  const plans: GroupPlan[] = [];

  for (const indices of components.values()) {
    if (indices.length < minGroupSize) continue;

    const docFreq = new Map<string, number>();
    const totalWeight = new Map<string, number>();
    for (const idx of indices) {
      for (const [term, w] of termMaps[idx].entries()) {
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
        totalWeight.set(term, (totalWeight.get(term) || 0) + w);
      }
    }

    const sharedTerms = [...docFreq.entries()]
      .filter(([, count]) => count >= Math.min(2, indices.length))
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return (totalWeight.get(b[0]) || 0) - (totalWeight.get(a[0]) || 0);
      })
      .slice(0, 2)
      .map(([term]) => term);

    const title =
      sharedTerms.length > 0
        ? sharedTerms.join(' · ')
        : extractDomain(getTabUrl(unpinned[indices[0]].tab));

    plans.push({
      title,
      color: pickGroupColor(title),
      collapsed: Boolean(collapseGroups),
      tabIds: indices
        .map((i) => unpinned[i].tab.id)
        .filter((id): id is number => id != null),
    });
  }

  return plans.sort((a, b) => b.tabIds.length - a.tabIds.length);
}

/**
 * Plan full similarity-based organization:
 * 1) Put judged unnecessary tabs into a "不要" group
 * 2) Cluster remaining tabs by content similarity
 */
export function planSmartOrganize(
  entries: InspectedEntry[],
  options: UnnecessaryAnalysisOptions & ClusterOptions = {}
): {
  plans: GroupPlan[];
  unnecessaryCount: number;
  protectedCount: number;
} {
  const { unnecessaryTabs, remainingEntries, protectedTabs } = analyzeUnnecessaryTabs(
    entries,
    options
  );
  const plans = clusterTabsByContent(remainingEntries, options);

  if (unnecessaryTabs.length > 0) {
    plans.push({
      title: '不要',
      color: 'grey',
      collapsed: Boolean(options.collapseGroups),
      tabIds: unnecessaryTabs
        .map((t) => t.id)
        .filter((id): id is number => id != null),
    });
  }

  return {
    plans,
    unnecessaryCount: unnecessaryTabs.length,
    protectedCount: protectedTabs.length,
  };
}
