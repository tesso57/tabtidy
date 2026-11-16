import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendToMapList,
  extractDomain,
  filterTabs,
  findDuplicateTabs,
  findStaleTabs,
  getSafeFaviconUrl,
  GROUP_COLORS,
  isRestorableUrl,
  isTabGrouped,
  pickGroupColor,
  summarizeTabs,
  toNonEmptyTabIds,
} from '../src/lib/tab-utils.ts';

describe('extractDomain', () => {
  it('extracts hostname and strips leading www.', () => {
    assert.equal(extractDomain('https://www.github.com/tesso57/repo'), 'github.com');
    assert.equal(extractDomain('http://docs.google.com/document/d/1'), 'docs.google.com');
  });

  it('handles special browser and local URLs', () => {
    assert.equal(extractDomain('chrome://extensions/'), 'Chrome設定');
    assert.equal(extractDomain('chrome-extension://abcdef/popup.html'), '拡張機能');
    assert.equal(extractDomain('file:///docs/test/index.html'), 'ローカルファイル');
    assert.equal(extractDomain('about:blank'), 'システム');
    assert.equal(extractDomain(''), 'その他');
    assert.equal(extractDomain('not-a-url'), 'その他');
  });
});

describe('isRestorableUrl', () => {
  it('allows only valid http and https URLs', () => {
    assert.equal(isRestorableUrl('https://example.com/path?q=1#hash'), true);
    assert.equal(isRestorableUrl('http://localhost:3000/dashboard'), true);
    assert.equal(isRestorableUrl('HTTPS://EXAMPLE.COM/UPPER'), true);

    assert.equal(isRestorableUrl('javascript:alert(1)'), false);
    assert.equal(isRestorableUrl('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isRestorableUrl('blob:https://example.com/123'), false);
    assert.equal(isRestorableUrl('vbscript:msgbox(1)'), false);
    assert.equal(isRestorableUrl('file:///etc/passwd'), false);
    assert.equal(isRestorableUrl('chrome://settings/'), false);
    assert.equal(isRestorableUrl('chrome-extension://abcdef/popup.html'), false);
    assert.equal(isRestorableUrl('about:blank'), false);
    assert.equal(isRestorableUrl('http://'), false);
    assert.equal(isRestorableUrl('not-a-url'), false);
    assert.equal(isRestorableUrl(''), false);
  });
});

describe('getSafeFaviconUrl', () => {
  it('allows http and https favicon URLs and rejects unsafe or malformed inputs', () => {
    assert.equal(getSafeFaviconUrl('https://example.com/favicon.ico'), 'https://example.com/favicon.ico');
    assert.equal(getSafeFaviconUrl('http://localhost:3000/icon.png'), 'http://localhost:3000/icon.png');
    assert.equal(getSafeFaviconUrl('chrome://favicon/https://example.com'), '');
    assert.equal(getSafeFaviconUrl('javascript:alert(1)', 'fallback.png'), 'fallback.png');
    assert.equal(getSafeFaviconUrl('data:image/png;base64,AAAA', 'fallback.png'), 'fallback.png');
    assert.equal(getSafeFaviconUrl('http://', 'fallback.png'), 'fallback.png');
    assert.equal(getSafeFaviconUrl('https://invalid host/icon.png', 'fallback.png'), 'fallback.png');
    assert.equal(getSafeFaviconUrl(undefined, 'fallback.png'), 'fallback.png');
  });
});

describe('pickGroupColor', () => {
  it('returns deterministic valid Chrome tabGroup color', () => {
    const c1 = pickGroupColor('github.com');
    const c2 = pickGroupColor('github.com');
    assert.equal(c1, c2);
    assert.ok(GROUP_COLORS.includes(c1));
  });
});

describe('toNonEmptyTabIds & helpers', () => {
  it('returns null for empty arrays and a non-empty tuple otherwise', () => {
    assert.equal(toNonEmptyTabIds([]), null);
    assert.deepEqual(toNonEmptyTabIds([42]), [42]);
    assert.deepEqual(toNonEmptyTabIds([1, 2, 3]), [1, 2, 3]);
  });

  it('appends values into Map bucket lists and checks tab group membership', () => {
    const map = new Map<string, number[]>();
    appendToMapList(map, 'a', 1);
    appendToMapList(map, 'a', 2);
    appendToMapList(map, 'b', 3);
    assert.deepEqual(map.get('a'), [1, 2]);
    assert.deepEqual(map.get('b'), [3]);

    assert.equal(isTabGrouped({}), false);
    assert.equal(isTabGrouped({ groupId: -1 }), false);
    assert.equal(isTabGrouped({ groupId: -2 }), false);
    assert.equal(isTabGrouped({ groupId: Number.NaN }), false);
    assert.equal(isTabGrouped({ groupId: Number.POSITIVE_INFINITY }), false);
    assert.equal(isTabGrouped({ groupId: 0 }), true);
    assert.equal(isTabGrouped({ groupId: 7 }), true);
  });
});

describe('findDuplicateTabs', () => {
  it('keeps active tab among unpinned duplicates and protects pinned tabs', () => {
    const tabs = [
      { id: 1, index: 0, url: 'https://github.com/a', pinned: true, active: false },
      { id: 2, index: 1, url: 'https://github.com/a', pinned: false, active: true },
      { id: 3, index: 2, url: 'https://example.com/1', pinned: false, active: false },
      { id: 4, index: 3, url: 'https://example.com/1', pinned: false, active: true },
      { id: 5, index: 4, url: 'https://example.com/2#top', pinned: false, active: false },
      { id: 6, index: 5, url: 'https://example.com/2#bottom', pinned: false, active: false },
    ];

    const exact = findDuplicateTabs(tabs, { ignoreHash: false });
    assert.deepEqual(
      exact.duplicateTabs.map((t) => t.id),
      [2, 3]
    );

    const noHash = findDuplicateTabs(tabs, { ignoreHash: true });
    assert.deepEqual(
      noHash.duplicateTabs.map((t) => t.id),
      [2, 3, 6]
    );
  });

  it('isolates incognito duplicates from normal tabs and handles malformed URLs with hashes', () => {
    const tabs = [
      { id: 1, index: 0, url: 'https://example.com/shared', incognito: false },
      { id: 2, index: 1, url: 'https://example.com/shared', incognito: true },
      { id: 3, index: 2, url: 'https://example.com/shared', incognito: true },
      { id: 4, index: 3, url: 'not-a-url#first', incognito: false },
      { id: 5, index: 4, url: 'not-a-url#second', incognito: false },
      { id: 6, index: 5, url: '' },
      { id: 7, index: 6, url: '' },
    ];

    const res = findDuplicateTabs(tabs, { ignoreHash: true });
    assert.deepEqual(
      res.duplicateTabs.map((t) => t.id),
      [3, 5]
    );
    assert.deepEqual(
      res.keepTabs.map((t) => t.id),
      [1, 2, 4]
    );
  });
});

describe('filterTabs & findStaleTabs & summarizeTabs', () => {
  it('filters by search tokens and category', () => {
    const tabs = [
      { id: 1, title: 'GitHub Dashboard', url: 'https://github.com', pinned: false, audible: false, groupId: -1 },
      { id: 2, title: 'Lo-Fi Radio', url: 'https://youtube.com/watch?v=1', pinned: false, audible: true, groupId: 5 },
      { id: 3, title: 'GitHub PR', url: 'https://github.com/org/repo', pinned: true, audible: false, groupId: -1 },
    ];

    assert.deepEqual(
      filterTabs(tabs, { query: 'github pr' }).map((t) => t.id),
      [3]
    );
    assert.deepEqual(
      filterTabs(tabs, { filter: 'audible' }).map((t) => t.id),
      [2]
    );
    assert.deepEqual(
      filterTabs(tabs, { filter: 'ungrouped' }).map((t) => t.id),
      [1]
    );
  });

  it('finds stale tabs excluding pinned, active, and audible tabs and handles non-finite thresholds', () => {
    const now = 1_000_000_000;
    const old = now - 120 * 60_000;
    const recent = now - 5 * 60_000;
    const tabs = [
      { id: 1, pinned: true, active: false, audible: false, lastAccessed: old },
      { id: 2, pinned: false, active: true, audible: false, lastAccessed: old },
      { id: 3, pinned: false, active: false, audible: true, lastAccessed: old },
      { id: 4, pinned: false, active: false, audible: false, lastAccessed: recent },
      { id: 5, pinned: false, active: false, audible: false, lastAccessed: old },
      { id: 6, pinned: false, active: false, audible: false, lastAccessed: Number.NaN },
    ];
    assert.deepEqual(
      findStaleTabs(tabs, 60, now).map((t) => t.id),
      [5]
    );
    assert.deepEqual(
      findStaleTabs(tabs, Number.NaN, now).map((t) => t.id),
      [5]
    );
    assert.deepEqual(
      findStaleTabs(tabs, Number.POSITIVE_INFINITY, now).map((t) => t.id),
      [5]
    );
    assert.deepEqual(
      findStaleTabs(tabs, -10, now).map((t) => t.id),
      [5]
    );
  });

  it('summarizes tab statistics without undercounting ungrouped when pinned tabs have groupId', () => {
    const tabs = [
      { id: 1, index: 0, url: 'https://github.com/a', pinned: false, groupId: -1 },
      { id: 2, index: 1, url: 'https://github.com/a', pinned: false, groupId: 5 },
      { id: 3, index: 2, url: 'https://docs.google.com/1', pinned: true, groupId: -1 },
    ];
    const summary = summarizeTabs(tabs);
    assert.equal(summary.total, 3);
    assert.equal(summary.pinned, 1);
    assert.equal(summary.grouped, 1);
    assert.equal(summary.ungrouped, 1);
    assert.equal(summary.duplicates, 1);
    assert.ok(summary.duplicateIds.has(2));

    const mixedTabs = [
      { id: 10, pinned: true, groupId: 5 },
      { id: 11, pinned: false, groupId: -1 },
    ];
    const mixedSummary = summarizeTabs(mixedTabs);
    assert.equal(mixedSummary.pinned, 1);
    assert.equal(mixedSummary.grouped, 1);
    assert.equal(mixedSummary.ungrouped, 1);
    assert.equal(filterTabs(mixedTabs, { filter: 'ungrouped' }).length, mixedSummary.ungrouped);
  });
});
