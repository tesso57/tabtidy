import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractDomain,
  filterTabs,
  findDuplicateTabs,
  findStaleTabs,
  getSafeFaviconUrl,
  GROUP_COLORS,
  pickGroupColor,
  summarizeTabs,
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

describe('getSafeFaviconUrl', () => {
  it('allows http and https favicon URLs and rejects unsafe protocols', () => {
    assert.equal(getSafeFaviconUrl('https://example.com/favicon.ico'), 'https://example.com/favicon.ico');
    assert.equal(getSafeFaviconUrl('http://localhost:3000/icon.png'), 'http://localhost:3000/icon.png');
    assert.equal(getSafeFaviconUrl('chrome://favicon/https://example.com'), '');
    assert.equal(getSafeFaviconUrl('javascript:alert(1)', 'fallback.png'), 'fallback.png');
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

  it('finds stale tabs excluding pinned, active, and audible tabs', () => {
    const now = 1_000_000_000;
    const old = now - 120 * 60_000;
    const recent = now - 5 * 60_000;
    const tabs = [
      { id: 1, pinned: true, active: false, audible: false, lastAccessed: old },
      { id: 2, pinned: false, active: true, audible: false, lastAccessed: old },
      { id: 3, pinned: false, active: false, audible: true, lastAccessed: old },
      { id: 4, pinned: false, active: false, audible: false, lastAccessed: recent },
      { id: 5, pinned: false, active: false, audible: false, lastAccessed: old },
    ];
    assert.deepEqual(
      findStaleTabs(tabs, 60, now).map((t) => t.id),
      [5]
    );
  });

  it('summarizes tab statistics', () => {
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
  });
});
