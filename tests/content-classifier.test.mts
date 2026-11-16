import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { InspectedEntry } from '../src/types/tab.ts';
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

  it('handles empty, punctuation-only, surrogate-pair, and prototype-key inputs safely', () => {
    assert.deepEqual(tokenizeText(''), []);
    assert.deepEqual(tokenizeText('--- | ___ ... !!! 「」【】 ＿＿'), []);
    assert.deepEqual(tokenizeText('🚀🔥 𠮷 𩸽'), []);

    const extTokens = tokenizeText('𠮷野家 𩸽typescript');
    assert.ok(extTokens.includes('野家'));
    assert.ok(extTokens.includes('typescript'));
    assert.ok(!extTokens.includes('𠮷'));
    assert.ok(!extTokens.includes('𩸽'));

    const protoTokens = tokenizeText('constructor toString __proto__ valueOf');
    assert.deepEqual(protoTokens, ['constructor', 'tostring', '__proto__', 'valueof']);
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

  it('clusters 250 sparse tabs rapidly (<100ms) with exact shared, transitive, and disjoint results', () => {
    const alphaTag = (index: number): string =>
      String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + (index % 26));

    const entries: InspectedEntry[] = [];

    // 20 disjoint 10-tab topic clusters (200 tabs), all sharing a weak noise term.
    for (let c = 0; c < 20; c += 1) {
      const tag = alphaTag(c);
      for (let j = 0; j < 10; j += 1) {
        const id = c * 10 + j + 1;
        const unique = alphaTag(100 + c * 10 + j);
        entries.push({
          tab: { id, url: `https://topic-${tag}.example.com/${j}`, title: `cluster${tag}one cluster${tag}two ${unique}title`, pinned: false },
          signals: {
            headings: `cluster${tag}one cluster${tag}three`,
            metaDesc: `cluster${tag}two cluster${tag}four`,
            bodyText: `sharednoise ${unique}body cluster${tag}one cluster${tag}five`,
          },
        });
      }
    }

    // 10 transitive-chain 3-tab clusters (30 tabs): A~B and B~C >= 0.2, while A~C < 0.2.
    for (let b = 0; b < 10; b += 1) {
      const tag = alphaTag(300 + b);
      const uTag = alphaTag(400 + b);
      const left = `bridge${tag}left`;
      const right = `bridge${tag}right`;
      const baseId = 201 + b * 3;
      entries.push(
        {
          tab: { id: baseId, url: `https://bridge-${tag}.example.com/a`, title: left, pinned: false },
          signals: { headings: left, bodyText: `sharednoise unique${uTag}a` },
        },
        {
          tab: { id: baseId + 1, url: `https://bridge-${tag}.example.com/b`, title: `${left} ${right}`, pinned: false },
          signals: { headings: `${left} ${right}`, bodyText: 'sharednoise' },
        },
        {
          tab: { id: baseId + 2, url: `https://bridge-${tag}.example.com/c`, title: right, pinned: false },
          signals: { headings: right, bodyText: `sharednoise unique${uTag}c` },
        }
      );
    }

    // 20 disjoint singleton tabs (20 tabs) that must stay ungrouped despite sharing `sharednoise`.
    for (let s = 0; s < 20; s += 1) {
      const tag = alphaTag(500 + s);
      entries.push({
        tab: { id: 231 + s, url: `https://solo-${tag}.example.com`, title: `solo${tag}title`, pinned: false },
        signals: { headings: `solo${tag}head`, bodyText: `sharednoise solo${tag}body` },
      });
    }

    assert.equal(entries.length, 250);

    // Warm up JIT once before measuring hot clustering latency.
    clusterTabsByContent(entries.slice(0, 30), { minGroupSize: 2, similarityThreshold: 0.2 });

    const start = performance.now();
    const plans = clusterTabsByContent(entries, { minGroupSize: 2, similarityThreshold: 0.2 });
    const elapsedMs = performance.now() - start;

    assert.ok(elapsedMs < 100, `Expected 250 sparse tab clustering <100ms, got ${elapsedMs.toFixed(2)}ms`);
    assert.equal(plans.length, 30);

    for (let c = 0; c < 20; c += 1) {
      const tag = alphaTag(c);
      const expectedIds = Array.from({ length: 10 }, (_, j) => c * 10 + j + 1);
      assert.equal(plans[c].title, `cluster${tag}one · cluster${tag}two`);
      assert.deepEqual(plans[c].tabIds, expectedIds);
    }

    for (let b = 0; b < 10; b += 1) {
      const tag = alphaTag(300 + b);
      const baseId = 201 + b * 3;
      assert.equal(plans[20 + b].title, `sharednoise · bridge${tag}left`);
      assert.deepEqual(plans[20 + b].tabIds, [baseId, baseId + 1, baseId + 2]);
    }
  });

  it('preserves edge-case clustering semantics for pinned, empty, zero-threshold, and minGroupSize=1', () => {
    const entries: InspectedEntry[] = [
      { tab: { id: 1, url: 'https://pinned.example.com', title: 'Kubernetes Guide', pinned: true }, signals: null },
      { tab: { id: 2, url: 'https://alpha.example.com/1', title: '', pinned: false }, signals: null },
      { tab: { id: 3, url: 'https://beta.example.com/2', title: 'Kubernetes Cluster', pinned: false }, signals: { bodyText: 'kubernetes' } },
      { tab: { url: 'https://noid.example.com', title: 'Kubernetes Missing ID', pinned: false }, signals: null },
    ];

    assert.deepEqual(clusterTabsByContent(entries, { minGroupSize: 2, similarityThreshold: 0.2 }), []);

    const singlePlans = clusterTabsByContent(entries, { minGroupSize: 1, collapseGroups: true, similarityThreshold: 0.2 });
    assert.equal(singlePlans.length, 2);
    assert.equal(singlePlans[0].title, 'alpha.example.com');
    assert.equal(singlePlans[0].collapsed, true);
    assert.deepEqual(singlePlans[0].tabIds, [2]);
    assert.equal(singlePlans[1].title, 'kubernetes · cluster');
    assert.deepEqual(singlePlans[1].tabIds, [3]);

    const mergedPlans = clusterTabsByContent(entries, { minGroupSize: 2, similarityThreshold: 0 });
    assert.equal(mergedPlans.length, 1);
    assert.deepEqual(mergedPlans[0].tabIds, [2, 3]);
    assert.equal(mergedPlans[0].title, 'alpha.example.com');

    assert.deepEqual(clusterTabsByContent([]), []);
  });

  it('sanitizes NaN/Infinity/negative options, prevents float overshoot >1, and supports prototype-key tokens', () => {
    const entries: InspectedEntry[] = [
      {
        tab: { id: 1, url: 'https://a.example.com/1', title: 'constructor __proto__ toString', pinned: false },
        signals: null,
      },
      {
        tab: { id: 2, url: 'https://b.example.com/2', title: 'constructor __proto__ toString', pinned: false },
        signals: null,
      },
      {
        tab: { id: 3, url: 'https://c.example.com/3', title: 'unrelated cooking recipe', pinned: false },
        signals: null,
      },
    ];

    for (const badOpts of [
      { minGroupSize: Number.NaN, similarityThreshold: Number.NaN },
      { minGroupSize: -2, similarityThreshold: -0.5 },
      { minGroupSize: Number.POSITIVE_INFINITY, similarityThreshold: Number.NEGATIVE_INFINITY },
      { minGroupSize: 0, similarityThreshold: Number.POSITIVE_INFINITY },
    ]) {
      const plans = clusterTabsByContent(entries, badOpts);
      assert.equal(plans.length, 1);
      assert.deepEqual(plans[0].tabIds, [1, 2]);
      assert.equal(plans[0].title, 'constructor · __proto__');
    }

    assert.deepEqual(
      clusterTabsByContent(entries, { minGroupSize: 2, similarityThreshold: 1.5 }),
      []
    );
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

  it('bounds overly long titles in analyzeUnnecessaryTabs and clusterTabsByContent', () => {
    const longFiller = 'a'.repeat(50_000);
    const now = 2_000_000_000;

    const entries = [
      {
        tab: {
          id: 1,
          url: 'https://example.com/1',
          title: `${longFiller} 404 Not Found`,
          pinned: false,
          active: true,
          lastAccessed: now,
        },
        signals: null,
      },
      {
        tab: {
          id: 2,
          url: 'https://example.com/2',
          title: `${'kubernetes '.repeat(5_000)}ガイド`,
          pinned: false,
          active: false,
          lastAccessed: now,
        },
        signals: null,
      },
      {
        tab: {
          id: 3,
          url: 'https://example.org/3',
          title: 'kubernetes クラスタ設計',
          pinned: false,
          active: false,
          lastAccessed: now,
        },
        signals: null,
      },
    ];

    const start = performance.now();
    const analysis = analyzeUnnecessaryTabs(entries, { nowMs: now });
    const plans = clusterTabsByContent(analysis.remainingEntries, { minGroupSize: 2, similarityThreshold: 0.2 });
    const elapsedMs = performance.now() - start;

    assert.equal(analysis.unnecessaryTabs.length, 0);
    assert.equal(plans.length, 1);
    assert.deepEqual([...plans[0].tabIds].sort((a, b) => a - b), [2, 3]);
    assert.ok(elapsedMs < 100, `Expected bounded title processing <100ms, got ${elapsedMs.toFixed(2)}ms`);
  });

  it('handles non-finite staleMinutes, avoids false search URL matches, and avoids splitting surrogate pairs', () => {
    const now = Date.now();
    const old2h = now - 120 * 60_000;
    const old20m = now - 20 * 60_000;
    const boundaryTitle = `${'a'.repeat(299)}🚀`;

    const entries: InspectedEntry[] = [
      {
        tab: {
          id: 1,
          url: 'https://example.com/?next=https://www.google.com/search?q=test',
          title: boundaryTitle,
          pinned: false,
          active: false,
          lastAccessed: old20m,
        },
        signals: null,
      },
      {
        tab: {
          id: 2,
          url: 'https://www.google.co.jp/search?q=typescript',
          title: 'typescript - Google 検索',
          pinned: false,
          active: false,
          lastAccessed: old20m,
        },
        signals: null,
      },
      {
        tab: {
          id: 3,
          url: 'https://docs.example.com/guide',
          title: 'Stale Guide',
          pinned: false,
          active: false,
          lastAccessed: old2h,
        },
        signals: null,
      },
    ];

    const res = analyzeUnnecessaryTabs(entries, {
      staleMinutes: Number.NaN,
      nowMs: Number.NaN,
    });
    assert.deepEqual(
      res.unnecessaryTabs.map((t) => t.id),
      [2, 3]
    );
    assert.equal(res.remainingEntries.length, 1);
    assert.equal(res.remainingEntries[0].tab.id, 1);

    const organizedEmpty = planSmartOrganize([]);
    assert.deepEqual(organizedEmpty, { plans: [], unnecessaryCount: 0, protectedCount: 0 });
  });
});

describe('stripTrailingSiteSuffix', () => {
  it('preserves existing suffix-stripping semantics across separators and edge cases', () => {
    assert.equal(stripTrailingSiteSuffix(''), '');
    assert.equal(
      stripTrailingSiteSuffix('週次スケジュール - Google カレンダー', 'https://calendar.google.com/calendar'),
      '週次スケジュール'
    );
    assert.equal(
      stripTrailingSiteSuffix('Pull Request #42 | GitHub', 'https://github.com/org/repo'),
      'Pull Request #42'
    );
    assert.equal(
      stripTrailingSiteSuffix('TypeScript 入門 – Qiita', 'https://qiita.com/items/1'),
      'TypeScript 入門'
    );
    assert.equal(
      stripTrailingSiteSuffix('設計メモ — Notion', 'https://www.notion.so/page'),
      '設計メモ'
    );
    assert.equal(
      stripTrailingSiteSuffix('Hooks の仕組み · Zenn', 'https://zenn.dev/articles/1'),
      'Hooks の仕組み'
    );
    assert.equal(
      stripTrailingSiteSuffix('商品ページ : Amazon', 'https://www.amazon.co.jp/dp/B000'),
      '商品ページ'
    );
    assert.equal(
      stripTrailingSiteSuffix('My Guide - Example Docs', 'https://docs.example.co.jp/guide'),
      'My Guide'
    );
    assert.equal(
      stripTrailingSiteSuffix('News - Microsoft Learn', 'https://learn.microsoft.com/en-us/'),
      'News'
    );
    assert.equal(
      stripTrailingSiteSuffix('Part 1 - Part 2 - Wikipedia', 'https://ja.wikipedia.org/wiki/Test'),
      'Part 1 - Part 2'
    );

    assert.equal(
      stripTrailingSiteSuffix('React - Hooks Guide', 'https://react.dev/hooks'),
      'React - Hooks Guide'
    );
    assert.equal(
      stripTrailingSiteSuffix('My Guide - co', 'https://example.co.jp/page'),
      'My Guide - co'
    );
    assert.equal(
      stripTrailingSiteSuffix('React-GitHub', 'https://github.com/facebook/react'),
      'React-GitHub'
    );
    assert.equal(
      stripTrailingSiteSuffix('React -GitHub', 'https://github.com/facebook/react'),
      'React -GitHub'
    );
    assert.equal(
      stripTrailingSiteSuffix('React- GitHub', 'https://github.com/facebook/react'),
      'React- GitHub'
    );
    assert.equal(
      stripTrailingSiteSuffix(`Page - ${'a'.repeat(27)}github`, 'https://github.com/org/repo'),
      `Page - ${'a'.repeat(27)}github`
    );
    assert.equal(
      stripTrailingSiteSuffix('   - GitHub', 'https://github.com/org/repo'),
      '   - GitHub'
    );
    assert.equal(
      stripTrailingSiteSuffix('Hooks - Web Dev', 'https://react.dev/hooks'),
      'Hooks - Web Dev'
    );
    assert.equal(
      stripTrailingSiteSuffix('My Guide - Commerce', 'https://example.com/guide'),
      'My Guide - Commerce'
    );
    assert.equal(
      stripTrailingSiteSuffix('メモ - その他', ''),
      'メモ - その他'
    );
    assert.equal(
      stripTrailingSiteSuffix('記事 🚀 - GitHub', 'not-a-url'),
      '記事 🚀'
    );
  });

  it('handles pathological whitespace strings in linear time (<50ms)', () => {
    const spaces = ' '.repeat(35_000);
    const noSeparator = `a${spaces}`;
    const nonSiteSuffix = `a${spaces} - UnknownSite`;
    const oversizedSuffix = `a${spaces} - ${'x'.repeat(40)}`;
    const whitespaceOnlyPrefix = `${spaces} - Google`;
    const validLongWhitespace = `a${spaces} - Wikipedia`;

    const start = performance.now();
    assert.equal(stripTrailingSiteSuffix(noSeparator, 'https://example.com'), noSeparator);
    assert.equal(stripTrailingSiteSuffix(nonSiteSuffix, 'https://example.com'), nonSiteSuffix);
    assert.equal(stripTrailingSiteSuffix(oversizedSuffix, 'https://example.com'), oversizedSuffix);
    assert.equal(stripTrailingSiteSuffix(whitespaceOnlyPrefix, 'https://google.com'), whitespaceOnlyPrefix);
    assert.equal(stripTrailingSiteSuffix(validLongWhitespace, 'https://ja.wikipedia.org/wiki/Test'), 'a');
    const elapsedMs = performance.now() - start;

    assert.ok(elapsedMs < 50, `Expected linear-time execution <50ms, got ${elapsedMs.toFixed(2)}ms`);
  });
});
