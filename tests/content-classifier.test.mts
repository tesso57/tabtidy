import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeUnnecessaryTabs,
  clusterTabsByContent,
  planSmartOrganize,
  stripTrailingSiteSuffix,
  tokenizeText,
} from '../src/lib/content-classifier.ts';

describe('tokenizeText', () => {
  it('extracts English and Japanese words while filtering stop words', () => {
    const tokens = tokenizeText('The Kubernetes EKS 設計ガイドとコンテナ運用');
    assert.ok(tokens.includes('kubernetes'));
    assert.ok(tokens.includes('eks'));
    assert.ok(tokens.includes('設計'));
    assert.ok(tokens.includes('ガイド'));
    assert.ok(tokens.includes('コンテナ'));
    assert.ok(!tokens.includes('the'));

    const placeTokens = tokenizeText('東京都渋谷区のカフェとランチ');
    assert.ok(placeTokens.includes('東京'));
    assert.ok(placeTokens.includes('渋谷'));
    assert.ok(placeTokens.includes('カフェ'));
    assert.ok(placeTokens.includes('ランチ'));
    assert.ok(!placeTokens.includes('の'));
  });
});

describe('clusterTabsByContent', () => {
  it('clusters cross-domain tabs sharing similar content and leaves unrelated tabs ungrouped', () => {
    const entries = [
      {
        tab: { id: 1, url: 'https://aws.amazon.com/blogs/eks', title: 'Amazon EKS Upgrade Guide', pinned: false },
        signals: { headings: 'Kubernetes EKS Ingress', bodyText: 'Upgrade kubernetes cluster nodes on EKS' },
      },
      {
        tab: { id: 2, url: 'https://github.com/terraform/issue/42', title: 'EKS Kubernetes module bug', pinned: false },
        signals: { headings: 'Kubernetes cluster error', bodyText: 'terraform eks cluster ingress controller' },
      },
      {
        tab: { id: 3, url: 'https://travel.example.jp/kyoto', title: '京都のおすすめホテル', pinned: false },
        signals: { headings: '京都 ホテル 観光', bodyText: '京都駅周辺のホテルと観光ルート' },
      },
      {
        tab: { id: 4, url: 'https://booking.example.com/hotel/kyoto', title: '京都 ホテル 予約', pinned: false },
        signals: { headings: '京都 宿泊プラン', bodyText: '京都のホテル宿泊料金を比較' },
      },
      {
        tab: { id: 5, url: 'https://example.org/cooking', title: 'カレーのレシピ', pinned: false },
        signals: { headings: 'スパイスカレー', bodyText: '玉ねぎを炒める' },
      },
    ];

    const plans = clusterTabsByContent(entries, { minGroupSize: 2, similarityThreshold: 0.15 });
    assert.equal(plans.length, 2);

    const groupTabSets = plans.map((p) => [...p.tabIds].sort((a, b) => a - b));
    assert.ok(groupTabSets.some((ids) => ids[0] === 1 && ids[1] === 2));
    assert.ok(groupTabSets.some((ids) => ids[0] === 3 && ids[1] === 4));
  });

  it('does not lump Google Calendar, Google Meet, and unrelated Google/Wikipedia tabs together', () => {
    assert.equal(
      stripTrailingSiteSuffix('週次スケジュール - Google カレンダー', 'https://calendar.google.com/calendar'),
      '週次スケジュール'
    );
    assert.equal(
      stripTrailingSiteSuffix('React - Hooks Guide', 'https://react.dev/hooks'),
      'React - Hooks Guide'
    );

    const entries = [
      {
        tab: { id: 10, url: 'https://calendar.google.com/calendar/r', title: 'Google カレンダー - 2026年11月', pinned: false },
        signals: { bodyText: '予定表 月曜日 火曜日 Google Calendar' },
      },
      {
        tab: { id: 11, url: 'https://meet.google.com/abc-defg-hij', title: 'abc-defg-hij - Google Meet', pinned: false },
        signals: { bodyText: 'カメラ マイク 参加 Google Meet' },
      },
      {
        tab: { id: 12, url: 'https://ja.wikipedia.org/wiki/量子力学', title: '量子力学 - Wikipedia', pinned: false },
        signals: { bodyText: '波動関数 シュレーディンガー方程式' },
      },
      {
        tab: { id: 13, url: 'https://ja.wikipedia.org/wiki/織田信長', title: '織田信長 - Wikipedia', pinned: false },
        signals: { bodyText: '戦国時代 安土城 本能寺の変' },
      },
    ];

    const plans = clusterTabsByContent(entries, { minGroupSize: 2, similarityThreshold: 0.2 });
    assert.equal(plans.length, 0);
  });
});

describe('analyzeUnnecessaryTabs & planSmartOrganize', () => {
  it('puts duplicates, errors, auth leftovers, stale searches, and stale tabs into 不要 group while protecting form drafts and audio', () => {
    const now = 2_000_000_000;
    const old2h = now - 120 * 60_000;
    const old20m = now - 20 * 60_000;

    const entries = [
      {
        tab: { id: 1, index: 0, url: 'https://github.com/org/repo/issues/new', title: 'New Issue', pinned: false, lastAccessed: old2h },
        signals: { hasFormDraft: true, bodyText: '' },
      },
      {
        tab: { id: 2, index: 1, url: 'https://youtube.com/watch?v=abc', title: 'BGM', pinned: false, audible: true, lastAccessed: old2h },
        signals: { hasVideo: true, bodyText: '' },
      },
      {
        tab: { id: 3, index: 2, url: 'https://example.com/missing', title: '404 Not Found', pinned: false, lastAccessed: now },
        signals: { bodyText: 'ページが見つかりません' },
      },
      {
        tab: { id: 4, index: 3, url: 'https://app.example.com/oauth/callback?code=1', title: '認証が完了しました', pinned: false, lastAccessed: now },
        signals: { bodyText: 'このウィンドウを閉じてください' },
      },
      {
        tab: { id: 5, index: 4, url: 'https://www.google.com/search?q=test', title: 'test - Google 検索', pinned: false, active: false, lastAccessed: old20m },
        signals: { bodyText: '検索結果' },
      },
      {
        tab: { id: 6, index: 5, url: 'https://zenn.dev/articles/long', title: '古い記事', pinned: false, active: false, lastAccessed: old2h },
        signals: { bodyText: '解説' },
      },
      {
        tab: { id: 7, index: 6, url: 'https://react.dev/learn', title: 'React Hooks Guide', pinned: false, active: true, lastAccessed: now },
        signals: { headings: 'React Hooks State', bodyText: 'react useState useEffect hooks' },
      },
      {
        tab: { id: 8, index: 7, url: 'https://blog.example.com/react-hooks', title: 'React Hooks まとめ', pinned: false, active: false, lastAccessed: now },
        signals: { headings: 'React Hooks State', bodyText: 'react useState hooks 入門' },
      },
    ];

    const analysis = analyzeUnnecessaryTabs(entries, {
      staleMinutes: 60,
      includeStaleInUnnecessary: true,
      nowMs: now,
    });
    assert.deepEqual(
      analysis.protectedTabs.map((t) => t.id),
      [1, 2]
    );
    assert.deepEqual(
      analysis.unnecessaryTabs.map((t) => t.id),
      [3, 4, 5, 6]
    );

    const organized = planSmartOrganize(entries, {
      staleMinutes: 60,
      includeStaleInUnnecessary: true,
      nowMs: now,
    });
    const trashPlan = organized.plans.find((p) => p.title === '不要');
    assert.ok(trashPlan);
    assert.equal(trashPlan.color, 'grey');
    assert.deepEqual(trashPlan.tabIds, [3, 4, 5, 6]);

    const simPlan = organized.plans.find((p) => p.title !== '不要');
    assert.ok(simPlan);
    assert.deepEqual([...simPlan.tabIds].sort((a, b) => a - b), [7, 8]);
  });
});
