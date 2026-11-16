import type { GroupPlan, InspectedEntry, PageSignals, TabLike } from '../types/tab.ts';
import {
  appendToMapList,
  extractDomain,
  findDuplicateTabs,
  getTabUrl,
  parseHttpUrl,
  pickGroupColor,
  toStaleCutoffMs,
} from './tab-utils.ts';

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

const ERROR_PATTERNS: readonly RegExp[] = [
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

const AUTH_LEFTOVER_PATTERNS: readonly RegExp[] = [
  /oauth\/?callback/i,
  /auth\/?callback/i,
  /認証が完了/,
  /ログインが完了/,
  /サインインしました/,
  /you can close this (tab|window)/i,
  /このウィンドウを閉じて/,
];

const MAX_TITLE_LENGTH = 300;
const MAX_SITE_SUFFIX_LENGTH = 32;
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/;
const WHITESPACE_RE = /\s/;
const EN_TOKEN_RE = /[a-z0-9][a-z0-9._-]{1,28}/g;
const EDGE_PUNCT_RE = /^[._-]+|[._-]+$/g;
const JA_TOKEN_RE = /[\u4E00-\u9FFF]{2,12}|[\u30A0-\u30FF]{2,14}/g;
const BRAND_SUFFIX_PREFIX_RE = /^(google|yahoo|microsoft)\s+/;
const PUNCT_OR_SYMBOL_ONLY_RE = /^[\p{P}\p{S}\p{Z}\p{C}]+$/u;

const GENERIC_SITE_SUFFIXES = new Set([
  'google', 'youtube', 'wikipedia', 'github', 'qiita', 'zenn', 'note',
  'amazon', 'rakuten', 'yahoo', 'twitter', 'x', 'facebook', 'instagram',
  'slack', 'notion', 'bing', 'microsoft',
]);

function isAsciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

function isTwoCharHiragana(value: string): boolean {
  if (value.length !== 2) return false;
  const c0 = value.charCodeAt(0);
  const c1 = value.charCodeAt(1);
  return c0 >= 0x3040 && c0 <= 0x309f && c1 >= 0x3040 && c1 <= 0x309f;
}

function isCommonLetterStart(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x3041 && code <= 0x30ff) ||
    (code >= 0x4e00 && code <= 0x9fff)
  );
}

function forEachToken(text: string, visit: (token: string) => void): void {
  if (!text || typeof text !== 'string') return;

  if (JA_SEGMENTER) {
    for (const { segment, isWordLike } of JA_SEGMENTER.segment(text)) {
      if (!isWordLike) continue;
      // Only U+0130 ('İ') expands to length >= 2 under trim().toLowerCase() from length < 2.
      if (segment.length < 2 && segment.charCodeAt(0) !== 0x0130) continue;
      const normalized = segment.trim().toLowerCase();
      if (normalized.length < 2) continue;
      if (
        normalized.length === 2 &&
        normalized.charCodeAt(0) >= 0xd800 &&
        normalized.charCodeAt(0) <= 0xdbff
      ) {
        continue;
      }
      if (!isCommonLetterStart(normalized.charCodeAt(0)) && PUNCT_OR_SYMBOL_ONLY_RE.test(normalized)) {
        continue;
      }
      if (isAsciiDigits(normalized)) continue;
      if (isTwoCharHiragana(normalized)) continue;
      if (STOP_WORDS.has(normalized)) continue;
      visit(normalized);
    }
    return;
  }

  const lower = text.toLowerCase();
  const enMatches = lower.match(EN_TOKEN_RE) ?? [];
  for (const w of enMatches) {
    const cleaned = w.replace(EDGE_PUNCT_RE, '');
    if (cleaned.length >= 2 && !isAsciiDigits(cleaned) && !STOP_WORDS.has(cleaned)) {
      visit(cleaned);
    }
  }

  const jaMatches = text.match(JA_TOKEN_RE) ?? [];
  for (const w of jaMatches) {
    if (!STOP_WORDS.has(w)) {
      visit(w);
    }
  }
}

export function tokenizeText(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const tokens: string[] = [];
  forEachToken(text, (token) => {
    tokens.push(token);
  });
  return tokens;
}

function isWhitespaceCode(code: number): boolean {
  if (code === 0x20) return true;
  if (code <= 0x20) return code >= 0x09 && code <= 0x0d;
  if (code < 0xa0) return false;
  return WHITESPACE_RE.test(String.fromCharCode(code));
}

function isSiteSuffixSeparatorCode(code: number): boolean {
  return (
    code === 0x2d || // -
    code === 0x7c || // |
    code === 0x2013 || // –
    code === 0x2014 || // —
    code === 0x00b7 || // ·
    code === 0x3a // :
  );
}

/**
 * Locate the rightmost trailing site-suffix separator in O(n) time without regex backtracking.
 */
function splitTrailingSuffix(title: string): { mainPart: string; suffixPart: string } | null {
  let sepIdx = -1;
  let firstNonWsAfterSep = -1;
  const minNonWsLimit = title.length - MAX_SITE_SUFFIX_LENGTH;

  // The suffix class forbids separators, so only the rightmost separator can match.
  // Any non-whitespace char further than MAX_SITE_SUFFIX_LENGTH from the end rules out a match.
  for (let i = title.length - 1; i >= 0; i -= 1) {
    const code = title.charCodeAt(i);
    if (isSiteSuffixSeparatorCode(code)) {
      sepIdx = i;
      break;
    }
    if (!isWhitespaceCode(code)) {
      if (i < minNonWsLimit) return null;
      firstNonWsAfterSep = i;
    }
  }

  if (sepIdx <= 0 || firstNonWsAfterSep === -1 || firstNonWsAfterSep === sepIdx + 1) {
    return null;
  }
  if (!isWhitespaceCode(title.charCodeAt(sepIdx - 1))) {
    return null;
  }

  let mainEnd = sepIdx - 1;
  while (mainEnd >= 0 && isWhitespaceCode(title.charCodeAt(mainEnd))) {
    mainEnd -= 1;
  }
  if (mainEnd < 0) return null;

  const rawMain = title.slice(0, mainEnd + 1);
  if (LINE_BREAK_RE.test(rawMain)) return null;

  const mainPart = rawMain.trim();
  if (mainPart.length === 0) return null;

  return {
    mainPart,
    suffixPart: title.slice(firstNonWsAfterSep),
  };
}

function sliceSafe(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const last = text.charCodeAt(maxLen - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, maxLen - 1) : text.slice(0, maxLen);
}

function getBoundedTitle(tab: TabLike, signals: Partial<PageSignals> | null | undefined): string {
  return sliceSafe(signals?.title || tab.title || '', MAX_TITLE_LENGTH);
}

/**
 * Strip trailing " - Site Name" / " | Site Name" suffixes from page titles
 * so unrelated pages on the same platform (e.g. Google Calendar vs Google Meet,
 * or two unrelated Wikipedia/YouTube pages) do not merge by brand name alone.
 */
export function stripTrailingSiteSuffix(title: string, url = ''): string {
  if (!title || typeof title !== 'string') return '';
  const split = splitTrailingSuffix(title);
  if (!split) return title;

  const suffixLower = split.suffixPart.trim().toLowerCase();
  if (GENERIC_SITE_SUFFIXES.has(suffixLower) || BRAND_SUFFIX_PREFIX_RE.test(suffixLower)) {
    return split.mainPart;
  }

  const parsed = parseHttpUrl(url);
  if (!parsed) return title;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const parts = host.split('.');
  const labels = parts.length > 1 ? parts.slice(0, -1) : parts;
  const domainLabels = labels.filter((p) => p.length >= 2 && p !== 'co' && p !== 'ne');

  return domainLabels.some((label) => suffixLower.includes(label)) ? split.mainPart : title;
}

function incrementMapValue<K>(map: Map<K, number>, key: K, delta = 1): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function collectTabIds(tabs: readonly TabLike[]): number[] {
  const ids: number[] = [];
  for (const tab of tabs) {
    if (tab.id != null) ids.push(tab.id);
  }
  return ids;
}

interface TermVector {
  readonly terms: ReadonlyMap<string, number>;
  readonly norm: number;
}

function addWeightedTokens(terms: Map<string, number>, text: string, weight: number): void {
  if (!text) return;
  forEachToken(text, (token) => {
    incrementMapValue(terms, token, weight);
  });
}

function buildTermVector(tab: TabLike, signals: Partial<PageSignals> | null): TermVector {
  const terms = new Map<string, number>();
  const rawTitle = getBoundedTitle(tab, signals);
  const cleanTitle = rawTitle ? stripTrailingSiteSuffix(rawTitle, getTabUrl(tab)) : '';

  addWeightedTokens(terms, cleanTitle, 3);
  addWeightedTokens(terms, signals?.headings || '', 2.5);
  addWeightedTokens(terms, signals?.metaDesc || '', 2);
  addWeightedTokens(terms, signals?.bodyText || '', 1);

  let normSq = 0;
  for (const weight of terms.values()) {
    normSq += weight * weight;
  }

  return {
    terms,
    norm: normSq > 0 ? Math.sqrt(normSq) : 0,
  };
}

function cosineSimilarity(dot: number, normA: number, normB: number): number {
  if (dot === 0 || normA === 0 || normB === 0) return 0;
  return Math.min(1, dot / (normA * normB));
}

function isSearchEngineResultsUrl(rawUrl: string): boolean {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const isSearchHost =
    /^google\.[a-z.]+$/.test(host) || host === 'bing.com' || host.endsWith('.bing.com');
  return isSearchHost && (parsed.pathname === '/search' || parsed.pathname.startsWith('/search/'));
}

export interface UnnecessaryAnalysisOptions {
  readonly staleMinutes?: number;
  readonly ignoreHash?: boolean;
  readonly includeStaleInUnnecessary?: boolean;
  readonly nowMs?: number;
}

export function analyzeUnnecessaryTabs(
  entries: readonly InspectedEntry[],
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

  const { duplicateTabs } = findDuplicateTabs(
    entries.map((e) => e.tab),
    { ignoreHash }
  );
  const duplicateIds = new Set(collectTabIds(duplicateTabs));
  const cutoffMs = toStaleCutoffMs(staleMinutes);
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();

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
    const title = getBoundedTitle(tab, signals);
    const body = signals?.bodyText || '';
    const textSample = `${title} ${body.slice(0, 250)}`;
    const inactiveMs =
      !tab.active && typeof tab.lastAccessed === 'number' && Number.isFinite(tab.lastAccessed)
        ? safeNowMs - tab.lastAccessed
        : null;

    const isError = ERROR_PATTERNS.some(
      (re) => re.test(title) || (body.length < 400 && re.test(textSample))
    );
    const isAuthLeftover = AUTH_LEFTOVER_PATTERNS.some(
      (re) => re.test(url) || re.test(textSample)
    );
    const isStaleSearch =
      inactiveMs !== null && inactiveMs >= 15 * 60_000 && isSearchEngineResultsUrl(url);
    const isStale = includeStaleInUnnecessary && inactiveMs !== null && inactiveMs >= cutoffMs;

    if (duplicateIds.has(tab.id) || isError || isAuthLeftover || isStaleSearch || isStale) {
      unnecessaryTabs.push(tab);
    } else {
      remainingEntries.push(entry);
    }
  }

  return { unnecessaryTabs, remainingEntries, protectedTabs };
}

export interface ClusterOptions {
  readonly minGroupSize?: number;
  readonly collapseGroups?: boolean;
  readonly similarityThreshold?: number;
}

function clusterSimilarVectors(
  vectors: readonly TermVector[],
  similarityThreshold: number
): (x: number) => number {
  const n = vectors.length;
  const parent = new Int32Array(n);
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    parent[i] = i;
  }

  const find = (x: number): number => {
    let curr = x;
    while (parent[curr] !== curr) {
      parent[curr] = parent[parent[curr]];
      curr = parent[curr];
    }
    return curr;
  };

  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb;
    } else if (rank[ra] > rank[rb]) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra] += 1;
    }
  };

  if (similarityThreshold <= 0) {
    for (let i = 1; i < n; i += 1) {
      union(0, i);
    }
    return find;
  }

  const invertedIndex = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    for (const term of vectors[i].terms.keys()) {
      appendToMapList(invertedIndex, term, i);
    }
  }

  const dots = new Float64Array(n);
  const seen = new Int32Array(n);
  const touched: number[] = [];

  for (let i = 0; i < n; i += 1) {
    const vecI = vectors[i];
    if (vecI.norm === 0) continue;

    // Positive stamp per i avoids clearing `seen`; -stamp caches same-component skips.
    const stamp = i + 1;
    let rootI = find(i);
    touched.length = 0;

    for (const [term, weightI] of vecI.terms) {
      const postings = invertedIndex.get(term);
      if (!postings || postings.length < 2) continue;

      for (let k = postings.length - 1; k >= 0; k -= 1) {
        const j = postings[k];
        if (j <= i) break;

        const state = seen[j];
        if (state === -stamp) continue;
        if (state !== stamp) {
          if (find(j) === rootI) {
            seen[j] = -stamp;
            continue;
          }
          seen[j] = stamp;
          touched.push(j);
        }
        dots[j] += weightI * (vectors[j].terms.get(term) ?? 0);
      }
    }

    for (let c = 0; c < touched.length; c += 1) {
      const j = touched[c];
      const dot = dots[j];
      dots[j] = 0;
      if (find(j) === rootI) continue;
      if (cosineSimilarity(dot, vecI.norm, vectors[j].norm) >= similarityThreshold) {
        union(i, j);
        rootI = find(i);
      }
    }
  }

  return find;
}

function buildClusterPlan(
  indices: readonly number[],
  vectors: readonly TermVector[],
  unpinned: readonly InspectedEntry[],
  collapsed: boolean
): GroupPlan {
  const docFreq = new Map<string, number>();
  const totalWeight = new Map<string, number>();
  const tabIds: number[] = [];

  for (const idx of indices) {
    const id = unpinned[idx].tab.id;
    if (id != null) tabIds.push(id);
    for (const [term, w] of vectors[idx].terms) {
      incrementMapValue(docFreq, term);
      incrementMapValue(totalWeight, term, w);
    }
  }

  const minCount = Math.min(2, indices.length);
  let firstTerm = '';
  let firstCount = -1;
  let firstWeight = -1;
  let secondTerm = '';
  let secondCount = -1;
  let secondWeight = -1;

  for (const [term, count] of docFreq) {
    if (count < minCount) continue;
    const weight = totalWeight.get(term) ?? 0;
    if (count > firstCount || (count === firstCount && weight > firstWeight)) {
      secondTerm = firstTerm;
      secondCount = firstCount;
      secondWeight = firstWeight;
      firstTerm = term;
      firstCount = count;
      firstWeight = weight;
    } else if (count > secondCount || (count === secondCount && weight > secondWeight)) {
      secondTerm = term;
      secondCount = count;
      secondWeight = weight;
    }
  }

  const title =
    firstCount >= minCount
      ? secondCount >= minCount
        ? `${firstTerm} · ${secondTerm}`
        : firstTerm
      : extractDomain(getTabUrl(unpinned[indices[0]].tab));

  return {
    title,
    color: pickGroupColor(title),
    collapsed,
    tabIds,
  };
}

export function clusterTabsByContent(
  entries: readonly InspectedEntry[],
  options: ClusterOptions = {}
): GroupPlan[] {
  const { minGroupSize = 2, collapseGroups = false, similarityThreshold = 0.2 } = options;
  const safeMinGroupSize =
    Number.isFinite(minGroupSize) && minGroupSize >= 1 ? Math.floor(minGroupSize) : 2;
  const safeThreshold =
    Number.isFinite(similarityThreshold) && similarityThreshold >= 0 ? similarityThreshold : 0.2;
  const unpinned = entries.filter((e) => !e.tab.pinned && e.tab.id != null);
  const n = unpinned.length;
  if (n === 0 || n < safeMinGroupSize) return [];

  const vectors = unpinned.map((e) => buildTermVector(e.tab, e.signals));
  const find = clusterSimilarVectors(vectors, safeThreshold);

  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    appendToMapList(components, find(i), i);
  }

  const plans: GroupPlan[] = [];
  const collapsed = Boolean(collapseGroups);
  for (const indices of components.values()) {
    if (indices.length < safeMinGroupSize) continue;
    plans.push(buildClusterPlan(indices, vectors, unpinned, collapsed));
  }

  return plans.sort((a, b) => b.tabIds.length - a.tabIds.length);
}

export function planSmartOrganize(
  entries: readonly InspectedEntry[],
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
      tabIds: collectTabIds(unnecessaryTabs),
    });
  }

  return {
    plans,
    unnecessaryCount: unnecessaryTabs.length,
    protectedCount: protectedTabs.length,
  };
}
