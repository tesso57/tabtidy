import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import {
  closeDuplicateTabs,
  DEFAULT_SETTINGS,
  deleteStashedSession,
  getSettings,
  getStashedSessions,
  getUndoSnapshot,
  groupTabsBySimilarity,
  queryScopedTabs,
  restoreStashedSession,
  restoreUndoSnapshot,
  safeCloseTabs,
  saveSettings,
  stashStaleTabs,
  stashTabs,
  ungroupAllTabs,
} from '../src/lib/chrome-actions.ts';

interface MockTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  title?: string;
  favIconUrl?: string;
  pinned: boolean;
  active?: boolean;
  incognito?: boolean;
  discarded?: boolean;
  groupId?: number;
  lastAccessed?: number;
  scriptError?: boolean;
  mockSignals?: {
    title?: string;
    headings?: string;
    bodyText?: string;
    hasFormDraft?: boolean;
  };
}

interface MockGroup {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
}

interface MockChromeOptions {
  readonly currentWindow?:
    | { readonly id?: number; readonly incognito?: boolean; readonly type?: string }
    | null
    | undefined;
  readonly lastFocusedWindow?: { readonly id?: number; readonly incognito?: boolean } | null;
  readonly failCreateUrls?: readonly string[];
  readonly failGroupIds?: readonly number[];
  readonly executeScriptDelayMs?: number;
  readonly storageDelayMs?: number;
  readonly hangTabIds?: readonly number[];
  readonly rawScriptResults?: ReadonlyMap<number, unknown>;
  readonly onExecuteScript?: (tabId: number) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createChromeMock(
  initialTabs: readonly MockTab[] = [],
  initialGroups: readonly MockGroup[] = [],
  options: MockChromeOptions = {}
) {
  const store: Record<string, unknown> = {};
  let nextTabId = 100;
  let nextGroupId = 500;
  let executeInFlight = 0;
  let tabs = initialTabs.map((t) => ({ ...t }));
  const groups = initialGroups.map((g) => ({ ...g }));
  const failCreateUrls = new Set(options.failCreateUrls ?? []);
  const failGroupIds = new Set(options.failGroupIds ?? []);
  const executeScriptDelayMs = options.executeScriptDelayMs ?? 0;
  const storageDelayMs = options.storageDelayMs ?? 0;
  const hangTabIds = new Set(options.hangTabIds ?? []);
  const currentWindow = 'currentWindow' in options ? options.currentWindow : { id: 1 };
  const lastFocusedWindow =
    'lastFocusedWindow' in options ? options.lastFocusedWindow : currentWindow;
  const executedTabIds: number[] = [];
  const calls = {
    grouped: [] as Array<{ groupId?: number; createProperties?: { windowId: number }; tabIds: number[] }>,
    updatedGroups: [] as Array<{ groupId: number; props: Partial<MockGroup> }>,
    createdTabs: [] as MockTab[],
    removedTabs: [] as number[],
    executedTabIds,
    maxExecuteInFlight: 0,
  };

  Reflect.set(globalThis, 'chrome', {
    storage: {
      local: {
        async get(key: string) {
          if (storageDelayMs > 0) await delay(storageDelayMs);
          return { [key]: store[key] };
        },
        async set(obj: Record<string, unknown>) {
          if (storageDelayMs > 0) await delay(storageDelayMs);
          Object.assign(store, obj);
        },
        async remove(key: string) {
          if (storageDelayMs > 0) await delay(storageDelayMs);
          delete store[key];
        },
      },
    },
    windows: {
      async getCurrent() {
        return currentWindow;
      },
      async getLastFocused() {
        return lastFocusedWindow;
      },
      async create({ url }: { url: string | string[] }) {
        const urls = Array.isArray(url) ? url : [url];
        for (const u of urls) {
          tabs.push({ id: nextTabId++, windowId: 2, url: u, pinned: false, index: tabs.length });
        }
        return { id: 2 };
      },
    },
    tabs: {
      async get(tabId: number) {
        const found = tabs.find((t) => t.id === tabId);
        if (!found) throw new Error(`No tab with id: ${tabId}`);
        return found;
      },
      async query(q: { windowId?: number } = {}) {
        return tabs.filter((t) => (q.windowId != null ? t.windowId === q.windowId : true));
      },
      async create({ windowId = 1, url = 'chrome://newtab/', active = false }) {
        if (failCreateUrls.has(url)) {
          throw new Error(`Blocked URL: ${url}`);
        }
        const created: MockTab = {
          id: nextTabId++,
          windowId,
          url,
          title: url,
          pinned: false,
          active,
          index: tabs.length,
        };
        tabs.push(created);
        calls.createdTabs.push(created);
        return created;
      },
      async remove(ids: number | number[]) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
          if (!tabs.some((t) => t.id === id)) {
            throw new Error(`No tab with id: ${id}`);
          }
        }
        calls.removedTabs.push(...list);
        tabs = tabs.filter((t) => !list.includes(t.id));
      },
      async group(opts: { groupId?: number; createProperties?: { windowId: number }; tabIds: number[] }) {
        if (opts.groupId && opts.createProperties) {
          throw new Error('Cannot specify both groupId and createProperties');
        }
        if (opts.groupId != null && failGroupIds.has(opts.groupId)) {
          throw new Error(`No group with id: ${opts.groupId}`);
        }
        for (const id of opts.tabIds) {
          const target = tabs.find((t) => t.id === id);
          if (!target) throw new Error(`No tab with id: ${id}`);
          if (target.pinned) throw new Error(`Pinned tab cannot be grouped: ${id}`);
        }
        calls.grouped.push(opts);
        const groupId = opts.groupId ?? nextGroupId++;
        if (!opts.groupId && opts.createProperties) {
          groups.push({
            id: groupId,
            windowId: opts.createProperties.windowId,
            title: '',
            color: 'grey',
            collapsed: false,
          });
        }
        for (const t of tabs) {
          if (opts.tabIds.includes(t.id)) t.groupId = groupId;
        }
        return groupId;
      },
      async ungroup(ids: number | number[]) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const t of tabs) {
          if (list.includes(t.id)) t.groupId = -1;
        }
      },
    },
    tabGroups: {
      async query(q: { windowId?: number } = {}) {
        return groups.filter((g) => (q.windowId != null ? g.windowId === q.windowId : true));
      },
      async update(groupId: number, props: Partial<MockGroup>) {
        calls.updatedGroups.push({ groupId, props });
        const g = groups.find((item) => item.id === groupId);
        if (g) Object.assign(g, props);
        return g;
      },
    },
    scripting: {
      async executeScript({ target }: { target: { tabId: number } }) {
        calls.executedTabIds.push(target.tabId);
        options.onExecuteScript?.(target.tabId);
        executeInFlight += 1;
        if (executeInFlight > calls.maxExecuteInFlight) {
          calls.maxExecuteInFlight = executeInFlight;
        }
        try {
          if (hangTabIds.has(target.tabId)) {
            return await new Promise<Array<{ result: MockTab['mockSignals'] | null }>>(() => {});
          }
          if (executeScriptDelayMs > 0) {
            await delay(executeScriptDelayMs);
          }
          if (options.rawScriptResults?.has(target.tabId)) {
            return [{ result: options.rawScriptResults.get(target.tabId) }];
          }
          const tab = tabs.find((t) => t.id === target.tabId);
          if (!tab || tab.scriptError) throw new Error('Cannot access tab');
          return [{ result: tab.mockSignals || null }];
        } finally {
          executeInFlight -= 1;
        }
      },
    },
  });

  return {
    getTabs: () => tabs,
    setTabs: (nextTabs: MockTab[]) => {
      tabs = nextTabs;
    },
    getGroups: () => groups,
    getStore: () => store,
    calls,
  };
}

describe('chrome-actions', () => {
  let mock: ReturnType<typeof createChromeMock>;

  beforeEach(() => {
    mock = createChromeMock([
      { id: 1, windowId: 1, index: 0, url: 'https://github.com/a', title: 'A', pinned: false, groupId: -1 },
      { id: 2, windowId: 1, index: 1, url: 'https://github.com/b', title: 'B', pinned: false, groupId: -1 },
      { id: 3, windowId: 1, index: 2, url: 'https://github.com/b', title: 'B', pinned: false, active: true, groupId: -1 },
    ]);
  });

  it('reuses existing 不要 group without passing createProperties alongside groupId', async () => {
    mock = createChromeMock(
      [
        {
          id: 1,
          windowId: 1,
          index: 0,
          url: 'https://example.org/404-a',
          title: '404 Not Found',
          pinned: false,
          groupId: 99,
          mockSignals: { bodyText: 'ページが見つかりません' },
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          url: 'https://example.org/404-b',
          title: '404 Not Found',
          pinned: false,
          groupId: -1,
          mockSignals: { bodyText: 'not found' },
        },
      ],
      [{ id: 99, windowId: 1, title: '不要', color: 'grey', collapsed: false }]
    );

    const res = await groupTabsBySimilarity('current', { collapseGroups: false });
    assert.equal(res.groupCount, 1);
    assert.equal(res.tabCount, 2);
    assert.equal(res.unnecessaryCount, 2);
    assert.equal(mock.calls.grouped[0].groupId, 99);
    assert.equal(mock.calls.grouped[0].createProperties, undefined);
  });

  it('closes duplicates and restores them via undo snapshot', async () => {
    const closed = await closeDuplicateTabs('current');
    assert.equal(closed, 1);
    assert.deepEqual(
      mock.getTabs().map((t) => t.id),
      [1, 3]
    );

    const restored = await restoreUndoSnapshot();
    assert.equal(restored, 1);
    assert.equal(mock.getTabs().length, 3);
  });

  it('opens a new tab before closing all tabs in a window', async () => {
    const closed = await safeCloseTabs(mock.getTabs());
    assert.equal(closed, 3);
    assert.equal(mock.calls.createdTabs.length, 1);
    assert.equal(mock.getTabs().length, 1);
    assert.equal(mock.getTabs()[0].url, 'chrome://newtab/');
  });

  it('stashes and restores sessions cleanly', async () => {
    const { session, closedCount } = await stashTabs(mock.getTabs(), '作業用');
    assert.equal(closedCount, 3);
    assert.equal(session?.name, '作業用');

    const sessions = await getStashedSessions();
    assert.equal(sessions.length, 1);

    const restored = await restoreStashedSession(session!.id, { newWindow: false, removeAfter: true });
    assert.equal(restored, 3);
    assert.equal((await getStashedSessions()).length, 0);
  });

  it('inspects page content to group cross-domain tabs and triage safely', async () => {
    mock = createChromeMock([
      {
        id: 10,
        windowId: 1,
        index: 0,
        url: 'https://blog.example.com/vite-guide',
        title: 'Vite Setup',
        pinned: false,
        mockSignals: { headings: 'Vite Build Tool', bodyText: 'vite config plugin bundle' },
      },
      {
        id: 11,
        windowId: 1,
        index: 1,
        url: 'https://github.com/vitejs/vite/issues/1',
        title: 'Vite plugin issue',
        pinned: false,
        mockSignals: { headings: 'Vite plugin config', bodyText: 'vite bundle error' },
      },
      {
        id: 12,
        windowId: 1,
        index: 2,
        url: 'https://example.org/broken',
        title: '404 Not Found',
        pinned: false,
        scriptError: true,
      },
      {
        id: 13,
        windowId: 1,
        index: 3,
        url: 'https://form.example.org/edit',
        title: '下書き',
        pinned: false,
        lastAccessed: Date.now() - 180 * 60_000,
        mockSignals: { hasFormDraft: true, bodyText: '' },
      },
    ]);

    const grouped = await groupTabsBySimilarity('current', { minGroupSize: 2 });
    assert.equal(grouped.inspectedCount, 3);
    assert.equal(grouped.groupCount, 2);
    assert.equal(grouped.tabCount, 3);
    assert.equal(grouped.unnecessaryCount, 1);
    assert.equal(grouped.protectedCount, 1);

    const unnecessaryGroup = mock.getGroups().find((g) => g.title === '不要');
    assert.ok(unnecessaryGroup);
    assert.equal(unnecessaryGroup.color, 'grey');
  });

  it('ungroups only unpinned grouped tabs', async () => {
    mock = createChromeMock([
      { id: 1, windowId: 1, index: 0, url: 'https://a.example', pinned: false, groupId: 10 },
      { id: 2, windowId: 1, index: 1, url: 'https://b.example', pinned: true, groupId: 10 },
      { id: 3, windowId: 1, index: 2, url: 'https://c.example', pinned: false, groupId: -1 },
    ]);

    assert.equal(await ungroupAllTabs('current'), 1);
    assert.deepEqual(
      mock.getTabs().map((t) => t.groupId),
      [-1, 10, -1]
    );
    assert.equal(await ungroupAllTabs('current'), 0);
  });

  it('excludes incognito and unsafe-protocol tabs from stashTabs and saveUndoSnapshot', async () => {
    mock = createChromeMock(
      [
        {
          id: 1,
          windowId: 1,
          index: 0,
          url: 'https://secret.example/a',
          title: 'Incognito A',
          pinned: false,
          incognito: true,
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          url: 'https://secret.example/a',
          title: 'Incognito A dup',
          pinned: false,
          incognito: true,
        },
        {
          id: 3,
          windowId: 1,
          index: 2,
          url: 'javascript:alert(1)',
          title: 'XSS',
          pinned: false,
        },
        {
          id: 4,
          windowId: 1,
          index: 3,
          url: 'chrome://settings/',
          title: 'Settings',
          pinned: false,
        },
        {
          id: 5,
          windowId: 1,
          index: 4,
          url: 'https://public.example/docs',
          favIconUrl: 'javascript:alert(1)',
          title: 'Public Docs',
          pinned: false,
        },
      ],
      [],
      { currentWindow: { id: 1, incognito: true } }
    );

    const closedIncognitoDup = await closeDuplicateTabs('current');
    assert.equal(closedIncognitoDup, 1);
    assert.equal(mock.getStore().tabtidy_last_closed, undefined);
    assert.equal(await getUndoSnapshot(), null);

    const { session, closedCount } = await stashTabs(mock.getTabs(), '安全退避');
    assert.equal(closedCount, 1);
    assert.equal(session?.tabs.length, 1);
    assert.equal(session?.tabs[0].url, 'https://public.example/docs');
    assert.equal(session?.tabs[0].favIconUrl, '');
    assert.deepEqual(
      mock.getTabs().map((t) => t.id),
      [1, 3, 4]
    );
  });

  it('isolates incognito tabs in queryScopedTabs("all") and falls back when getCurrent is null', async () => {
    const sampleTabs: MockTab[] = [
      { id: 1, windowId: 1, index: 0, url: 'https://normal.example', pinned: false, incognito: false },
      { id: 2, windowId: 2, index: 0, url: 'https://incognito.example', pinned: false, incognito: true },
    ];

    mock = createChromeMock(sampleTabs, [], { currentWindow: { id: 1, incognito: false } });
    const normalAll = await queryScopedTabs('all');
    assert.deepEqual(
      normalAll.tabs.map((t) => t.id),
      [1]
    );

    mock = createChromeMock(sampleTabs, [], { currentWindow: { id: 2, incognito: true } });
    const incognitoAll = await queryScopedTabs('all');
    assert.deepEqual(
      incognitoAll.tabs.map((t) => t.id),
      [2]
    );

    mock = createChromeMock(sampleTabs, [], { currentWindow: null });
    const nullCurrent = await queryScopedTabs('current');
    assert.deepEqual(nullCurrent, { tabs: [], currentWindowId: null });
    const nullAll = await queryScopedTabs('all');
    assert.deepEqual(
      nullAll.tabs.map((t) => t.id),
      [1]
    );
  });

  it('validates corrupted storage shapes and skips invalid/failing URLs during restore', async () => {
    mock = createChromeMock(
      [{ id: 1, windowId: 1, index: 0, url: 'https://keep.example', pinned: false }],
      [],
      { failCreateUrls: ['https://blocked.example/fail'] }
    );

    await chrome.storage.local.set({
      tabtidy_settings: ['corrupted-array'],
      tabtidy_last_closed: { closedAt: 'bad', tabs: 'bad' },
      tabtidy_stashed_sessions: 'corrupted-string',
    });
    assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
    assert.equal(await getUndoSnapshot(), null);
    assert.deepEqual(await getStashedSessions(), []);

    await chrome.storage.local.set({
      tabtidy_settings: {
        autoGroup: 'true',
        minGroupSize: -3,
        staleMinutes: Number.NaN,
        showBadge: false,
      },
      tabtidy_last_closed: {
        closedAt: Date.now(),
        tabs: [
          null,
          { url: 'javascript:alert(1)', title: 'Bad JS' },
          { url: 'not-a-url', title: 'Malformed' },
          { url: 'https://blocked.example/fail', title: 'Fails create' },
          { url: 'https://restored.example/ok', title: 123 },
        ],
      },
      tabtidy_stashed_sessions: [
        'corrupted-entry',
        { id: 'empty-bad', name: 'Bad Only', createdAt: 1000, tabs: [{ url: 'data:text/html,x', title: 'bad' }] },
        {
          id: 'mixed-session',
          name: 'Mixed',
          createdAt: 2000,
          tabs: [
            null,
            { url: 'file:///etc/passwd', title: 'Local File', favIconUrl: '' },
            { url: 'https://stash-ok.example', title: 'Stash OK', favIconUrl: 'javascript:alert(2)' },
          ],
        },
      ],
    });

    const settings = await getSettings();
    assert.deepEqual(settings, { ...DEFAULT_SETTINGS, showBadge: false });

    const snapshot = await getUndoSnapshot();
    assert.equal(snapshot?.tabs.length, 2);
    assert.equal(snapshot?.tabs[1].title, 'https://restored.example/ok');

    const restoredUndo = await restoreUndoSnapshot();
    assert.equal(restoredUndo, 1);
    assert.equal(await getUndoSnapshot(), null);
    assert.ok(mock.getTabs().some((t) => t.url === 'https://restored.example/ok'));

    const sessions = await getStashedSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'mixed-session');
    assert.equal(sessions[0].tabs.length, 1);
    assert.equal(sessions[0].tabs[0].favIconUrl, '');

    const restoredStash = await restoreStashedSession('mixed-session', { newWindow: false, removeAfter: true });
    assert.equal(restoredStash, 1);
    assert.equal((await getStashedSessions()).length, 0);
    assert.ok(mock.getTabs().some((t) => t.url === 'https://stash-ok.example'));
  });

  it('bounds concurrent executeScript calls in inspectTabsContent and skips discarded/non-HTTP tabs', async () => {
    const inspectableTabs: MockTab[] = Array.from({ length: 24 }, (_, idx) => ({
      id: idx + 1,
      windowId: 1,
      index: idx,
      url: `https://docs-${idx}.example.org/guide/kubernetes`,
      title: `Kubernetes Guide ${idx}`,
      pinned: false,
      mockSignals: {
        headings: 'Kubernetes Cluster Guide',
        bodyText: 'kubernetes deployment service ingress config',
      },
    }));
    const skippedTabs: MockTab[] = [
      {
        id: 25,
        windowId: 1,
        index: 24,
        url: 'https://discarded.example.org/page',
        title: 'Discarded Tab',
        pinned: false,
        discarded: true,
        mockSignals: { bodyText: 'should not be inspected' },
      },
      {
        id: 26,
        windowId: 1,
        index: 25,
        url: 'chrome://settings/',
        title: 'Settings',
        pinned: false,
      },
      {
        id: 27,
        windowId: 1,
        index: 26,
        url: 'about:blank',
        title: 'Blank',
        pinned: false,
      },
    ];

    mock = createChromeMock([...inspectableTabs, ...skippedTabs], [], {
      executeScriptDelayMs: 12,
    });

    const grouped = await groupTabsBySimilarity('current', { minGroupSize: 2 });
    assert.equal(grouped.inspectedCount, 24);
    assert.equal(mock.calls.executedTabIds.length, 24);
    assert.ok(mock.calls.maxExecuteInFlight >= 2 && mock.calls.maxExecuteInFlight <= 8);
    assert.ok(!mock.calls.executedTabIds.includes(25));
    assert.ok(!mock.calls.executedTabIds.includes(26));
    assert.ok(!mock.calls.executedTabIds.includes(27));
    assert.ok(grouped.groupCount >= 1);
  });

  it('falls back to null when executeScript exceeds the 700ms inspection timeout', async () => {
    mock = createChromeMock(
      [
        {
          id: 1,
          windowId: 1,
          index: 0,
          url: 'https://alpha.example.com/react-hooks',
          title: 'React Hooks',
          pinned: false,
          mockSignals: { headings: 'React Hooks', bodyText: 'useEffect useMemo react component' },
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          url: 'https://beta.example.org/react-state',
          title: 'React State',
          pinned: false,
          mockSignals: { headings: 'React State', bodyText: 'useEffect react component state' },
        },
        {
          id: 3,
          windowId: 1,
          index: 2,
          url: 'https://slow.example.net/hang',
          title: 'Slow Page',
          pinned: false,
        },
      ],
      [],
      { hangTabIds: [3] }
    );

    const grouped = await groupTabsBySimilarity('current', { minGroupSize: 2 });
    assert.equal(grouped.inspectedCount, 2);
    assert.equal(grouped.groupCount, 1);
    assert.equal(grouped.tabCount, 2);
  });

  it('sanitizes saveSettings inputs and serializes concurrent updates', async () => {
    mock = createChromeMock([], [], { storageDelayMs: 10 });

    const invalidResult = await saveSettings({
      minGroupSize: -5,
      staleMinutes: Number.NaN,
      autoGroup: true,
    });
    assert.equal(invalidResult.autoGroup, true);
    assert.equal(invalidResult.minGroupSize, DEFAULT_SETTINGS.minGroupSize);
    assert.equal(invalidResult.staleMinutes, DEFAULT_SETTINGS.staleMinutes);

    const [first, second] = await Promise.all([
      saveSettings({ collapseGroups: true }),
      saveSettings({ showBadge: false }),
    ]);
    assert.equal(first.collapseGroups, true);
    assert.equal(second.collapseGroups, true);
    assert.equal(second.showBadge, false);

    const persisted = await getSettings();
    assert.equal(persisted.collapseGroups, true);
    assert.equal(persisted.showBadge, false);
    assert.equal(persisted.autoGroup, true);
  });

  it('skips closed, pinned, and duplicate tab entries in safeCloseTabs', async () => {
    mock = createChromeMock([
      { id: 1, windowId: 1, index: 0, url: 'https://keep.example', pinned: false },
      { id: 2, windowId: 1, index: 1, url: 'https://pinned-later.example', pinned: true },
    ]);

    const closed = await safeCloseTabs([
      { id: 1, windowId: 1, url: 'https://keep.example', pinned: false },
      { id: 1, windowId: 1, url: 'https://keep.example', pinned: false },
      { id: 2, windowId: 1, url: 'https://pinned-later.example', pinned: false },
      { id: 999, windowId: 1, url: 'https://already-closed.example', pinned: false },
    ]);

    assert.equal(closed, 1);
    assert.deepEqual(mock.calls.removedTabs, [1]);
    assert.deepEqual(
      mock.getTabs().map((t) => t.id),
      [2]
    );
  });

  it('guards applyGroupPlansInWindow against tabs closed/pinned mid-inspection and stale existing groups', async () => {
    mock = createChromeMock(
      [
        {
          id: 1,
          windowId: 1,
          index: 0,
          url: 'https://a.example.com/react-hooks',
          title: 'React Hooks',
          pinned: false,
          mockSignals: { headings: 'React Hooks', bodyText: 'react hooks effect memo' },
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          url: 'https://b.example.org/react-state',
          title: 'React State',
          pinned: false,
          mockSignals: { headings: 'React State', bodyText: 'react state reducer memo' },
        },
        {
          id: 3,
          windowId: 1,
          index: 2,
          url: 'https://c.example.net/react-context',
          title: 'React Context',
          pinned: false,
          mockSignals: { headings: 'React Context', bodyText: 'react context provider memo' },
        },
      ],
      [{ id: 90, windowId: 1, title: '不要', color: 'grey', collapsed: false }],
      {
        failGroupIds: [90],
        onExecuteScript(tabId) {
          if (tabId === 3) {
            mock.setTabs(mock.getTabs().filter((t) => t.id !== 3));
            const second = mock.getTabs().find((t) => t.id === 2);
            if (second) second.pinned = true;
          }
        },
      }
    );

    const res = await groupTabsBySimilarity('current', { minGroupSize: 2 });
    assert.equal(res.groupCount, 1);
    assert.equal(res.tabCount, 1);
    assert.deepEqual(mock.calls.grouped[0].tabIds, [1]);

    mock = createChromeMock(
      [
        {
          id: 10,
          windowId: 1,
          index: 0,
          url: 'https://broken.example/404',
          title: '404 Not Found',
          pinned: false,
          mockSignals: { bodyText: 'not found' },
        },
      ],
      [{ id: 90, windowId: 1, title: '不要', color: 'grey', collapsed: false }],
      { failGroupIds: [90] }
    );

    const fallbackRes = await groupTabsBySimilarity('current');
    assert.equal(fallbackRes.groupCount, 1);
    assert.equal(fallbackRes.tabCount, 1);
    assert.equal(mock.calls.grouped[0].createProperties?.windowId, 1);
  });

  it('sanitizes control characters and rejects non-object executeScript results', async () => {
    const rawScriptResults = new Map<number, unknown>([
      [
        1,
        {
          title: '  Vite\u0000\nGuide\t ',
          headings: '\u0007Vite\u007f Bundler',
          bodyText: 'vite\u0000\r\nconfig\tplugin',
          hasFormDraft: 'yes',
          hasVideo: 1,
        },
      ],
      [2, 'unexpected-string-payload'],
    ]);

    mock = createChromeMock(
      [
        { id: 1, windowId: 1, index: 0, url: 'https://a.example/vite', title: 'A', pinned: false },
        { id: 2, windowId: 1, index: 1, url: 'https://b.example/vite', title: 'Vite Bundler', pinned: false },
      ],
      [],
      { rawScriptResults }
    );

    const res = await groupTabsBySimilarity('current', { minGroupSize: 2 });
    assert.equal(res.inspectedCount, 1);
    assert.equal(res.groupCount, 1);
    assert.equal(res.protectedCount, 0);
  });

  it('serializes concurrent stash deletes/restores and normalizes invalid stashStaleTabs threshold', async () => {
    mock = createChromeMock(
      [
        {
          id: 1,
          windowId: 1,
          index: 0,
          url: 'https://stale.example/1',
          title: 'Stale 1',
          pinned: false,
          lastAccessed: Date.now() - 120 * 60_000,
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          url: 'https://fresh.example/2',
          title: 'Fresh 2',
          pinned: false,
          lastAccessed: Date.now(),
        },
        {
          id: 3,
          windowId: 1,
          index: 2,
          url: 'https://new.example/3',
          title: 'New 3',
          pinned: false,
          lastAccessed: Date.now(),
        },
      ],
      [],
      { storageDelayMs: 10 }
    );

    const staleRes = await stashStaleTabs('current', Number.NaN);
    assert.equal(staleRes.closedCount, 1);
    assert.equal(staleRes.session?.name, '古いタブ (60分以上未操作)');

    const s1 = await stashTabs(
      [{ id: 2, windowId: 1, url: 'https://fresh.example/2', title: 'Fresh 2', pinned: false }],
      'S1'
    );
    assert.equal(s1.closedCount, 1);
    assert.equal((await getStashedSessions()).length, 2);

    const [restoredCount, s2] = await Promise.all([
      restoreStashedSession(staleRes.session!.id, { newWindow: false, removeAfter: true }),
      stashTabs(
        [{ id: 3, windowId: 1, url: 'https://new.example/3', title: 'New 3', pinned: false }],
        'S2'
      ),
    ]);
    assert.equal(restoredCount, 1);
    assert.equal(s2.closedCount, 1);
    assert.deepEqual(
      (await getStashedSessions()).map((s) => s.id),
      [s2.session!.id, s1.session!.id]
    );

    await Promise.all([
      deleteStashedSession(s1.session!.id),
      deleteStashedSession(s2.session!.id),
    ]);
    assert.equal((await getStashedSessions()).length, 0);
  });

  it('respects ignoreHashForDedup when passed directly via ExtensionSettings in groupTabsBySimilarity', async () => {
    mock = createChromeMock([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://docs.example/page#top',
        title: 'Docs Top',
        pinned: false,
      },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: 'https://docs.example/page#bottom',
        title: 'Docs Bottom',
        pinned: false,
      },
    ]);

    const res = await groupTabsBySimilarity('current', {
      ...DEFAULT_SETTINGS,
      ignoreHashForDedup: true,
    });
    assert.equal(res.unnecessaryCount, 1);
    assert.equal(res.groupCount, 1);
    assert.equal(mock.getGroups()[0].title, '不要');
  });
});

describe('service-worker', () => {
  type Listener<Args extends unknown[]> = (...args: Args) => void;

  let swState: {
    tabs: MockTab[];
    groups: MockGroup[];
    store: Record<string, unknown>;
    lastFocusedWindow: { id: number; incognito?: boolean } | null;
    badgeTexts: Array<string | undefined>;
    badgeColors: Array<string | number[]>;
    groupedCalls: Array<{ groupId?: number; createProperties?: { windowId: number }; tabIds: number[] }>;
    onStorageGet?: () => void;
    reset: (opts?: {
      tabs?: readonly MockTab[];
      groups?: readonly MockGroup[];
      store?: Record<string, unknown>;
      lastFocusedWindow?: { id: number; incognito?: boolean } | null;
      onStorageGet?: () => void;
    }) => void;
  };

  const listeners = {
    onInstalled: [] as Array<Listener<[]>>,
    onStartup: [] as Array<Listener<[]>>,
    onTabCreated: [] as Array<Listener<[MockTab]>>,
    onTabRemoved: [] as Array<Listener<[number]>>,
    onTabUpdated: [] as Array<Listener<[number, { status?: string; url?: string; pinned?: boolean }, MockTab]>>,
    onWindowRemoved: [] as Array<Listener<[number]>>,
    onWindowFocusChanged: [] as Array<Listener<[number]>>,
    onStorageChanged: [] as Array<Listener<[Record<string, unknown>, string]>>,
    onCommand: [] as Array<Listener<[string]>>,
  };

  before(async () => {
    let nextTabId = 500;
    let nextGroupId = 800;

    swState = {
      tabs: [
        { id: 1, windowId: 1, index: 0, url: 'https://init.example', pinned: false, groupId: -1 },
      ],
      groups: [],
      store: {},
      lastFocusedWindow: { id: 1, incognito: false },
      badgeTexts: [],
      badgeColors: [],
      groupedCalls: [],
      reset(opts = {}) {
        swState.tabs = (opts.tabs ?? []).map((t) => ({ ...t }));
        swState.groups = (opts.groups ?? []).map((g) => ({ ...g }));
        swState.store = opts.store ? { ...opts.store } : {};
        swState.lastFocusedWindow =
          'lastFocusedWindow' in opts ? (opts.lastFocusedWindow ?? null) : { id: 1, incognito: false };
        swState.badgeTexts = [];
        swState.badgeColors = [];
        swState.groupedCalls = [];
        swState.onStorageGet = opts.onStorageGet;
      },
    };

    Reflect.set(globalThis, 'chrome', {
      runtime: {
        onInstalled: { addListener: (fn: Listener<[]>) => listeners.onInstalled.push(fn) },
        onStartup: { addListener: (fn: Listener<[]>) => listeners.onStartup.push(fn) },
      },
      action: {
        async setBadgeText({ text }: { text?: string }) {
          swState.badgeTexts.push(text);
        },
        async setBadgeBackgroundColor({ color }: { color: string | number[] }) {
          swState.badgeColors.push(color);
        },
      },
      storage: {
        local: {
          async get(key: string) {
            swState.onStorageGet?.();
            await delay(5);
            return { [key]: swState.store[key] };
          },
          async set(obj: Record<string, unknown>) {
            Object.assign(swState.store, obj);
          },
          async remove(key: string) {
            delete swState.store[key];
          },
        },
        onChanged: {
          addListener: (fn: Listener<[Record<string, unknown>, string]>) =>
            listeners.onStorageChanged.push(fn),
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        async getCurrent() {
          return swState.lastFocusedWindow;
        },
        async getLastFocused() {
          return swState.lastFocusedWindow;
        },
        onRemoved: {
          addListener: (fn: Listener<[number]>) => listeners.onWindowRemoved.push(fn),
        },
        onFocusChanged: {
          addListener: (fn: Listener<[number]>) => listeners.onWindowFocusChanged.push(fn),
        },
      },
      tabs: {
        async get(tabId: number) {
          const tab = swState.tabs.find((t) => t.id === tabId);
          if (!tab) throw new Error(`No tab with id: ${tabId}`);
          return tab;
        },
        async query(q: { windowId?: number } = {}) {
          return swState.tabs.filter((t) => (q.windowId != null ? t.windowId === q.windowId : true));
        },
        async create({ windowId = 1, url = 'chrome://newtab/', active = false }) {
          const created: MockTab = {
            id: nextTabId++,
            windowId,
            url,
            title: url,
            pinned: false,
            active,
            index: swState.tabs.length,
          };
          swState.tabs.push(created);
          return created;
        },
        async remove(ids: number | number[]) {
          const list = Array.isArray(ids) ? ids : [ids];
          swState.tabs = swState.tabs.filter((t) => !list.includes(t.id));
        },
        async group(opts: { groupId?: number; createProperties?: { windowId: number }; tabIds: number[] }) {
          swState.groupedCalls.push(opts);
          const groupId = opts.groupId ?? nextGroupId++;
          if (!opts.groupId && opts.createProperties) {
            swState.groups.push({
              id: groupId,
              windowId: opts.createProperties.windowId,
              title: '',
              color: 'grey',
              collapsed: false,
            });
          }
          for (const t of swState.tabs) {
            if (opts.tabIds.includes(t.id)) t.groupId = groupId;
          }
          return groupId;
        },
        async ungroup(ids: number | number[]) {
          const list = Array.isArray(ids) ? ids : [ids];
          for (const t of swState.tabs) {
            if (list.includes(t.id)) t.groupId = -1;
          }
        },
        onCreated: { addListener: (fn: Listener<[MockTab]>) => listeners.onTabCreated.push(fn) },
        onRemoved: { addListener: (fn: Listener<[number]>) => listeners.onTabRemoved.push(fn) },
        onAttached: { addListener: () => {} },
        onDetached: { addListener: () => {} },
        onUpdated: {
          addListener: (
            fn: Listener<[number, { status?: string; url?: string; pinned?: boolean }, MockTab]>
          ) => listeners.onTabUpdated.push(fn),
        },
      },
      tabGroups: {
        async query(q: { windowId?: number } = {}) {
          return swState.groups.filter((g) => (q.windowId != null ? g.windowId === q.windowId : true));
        },
        async update(groupId: number, props: Partial<MockGroup>) {
          const g = swState.groups.find((item) => item.id === groupId);
          if (g) Object.assign(g, props);
          return g;
        },
      },
      scripting: {
        async executeScript({ target }: { target: { tabId: number } }) {
          const tab = swState.tabs.find((t) => t.id === target.tabId);
          return [{ result: tab?.mockSignals ?? null }];
        },
      },
      commands: {
        onCommand: { addListener: (fn: Listener<[string]>) => listeners.onCommand.push(fn) },
      },
    });

    await import('../src/background/service-worker.ts');
    await delay(90);
  });

  it('debounces badge updates, re-applies color after onInstalled, and clears badge on window removal', async () => {
    swState.reset({
      tabs: [
        { id: 1, windowId: 1, index: 0, url: 'https://a.example', pinned: false },
        { id: 2, windowId: 1, index: 1, url: 'https://b.example', pinned: false },
      ],
    });

    for (const fn of listeners.onTabCreated) {
      fn(swState.tabs[0]);
      fn(swState.tabs[1]);
    }
    await delay(90);
    assert.deepEqual(swState.badgeTexts, ['2']);
    assert.equal(swState.badgeColors.length, 0);

    for (const fn of listeners.onInstalled) fn();
    await delay(90);
    assert.equal(swState.badgeColors.length, 1);
    assert.deepEqual(swState.badgeTexts, ['2', '2']);

    swState.lastFocusedWindow = null;
    for (const fn of listeners.onWindowRemoved) fn(1);
    await delay(90);
    assert.equal(swState.badgeTexts[swState.badgeTexts.length - 1], '');
  });

  it('cancels pending auto-group on close/redirect and serializes concurrent same-domain tabs', async () => {
    const tab1: MockTab = {
      id: 10,
      windowId: 1,
      index: 0,
      url: 'https://github.com/a',
      pinned: false,
      groupId: -1,
    };
    const tab2: MockTab = {
      id: 11,
      windowId: 1,
      index: 1,
      url: 'https://github.com/b',
      pinned: false,
      groupId: -1,
    };

    swState.reset({
      tabs: [tab1, tab2],
      store: { tabtidy_settings: { autoGroup: true, minGroupSize: 2 } },
    });

    for (const fn of listeners.onTabUpdated) fn(10, { status: 'complete' }, tab1);
    swState.tabs = [tab2];
    for (const fn of listeners.onTabRemoved) fn(10);
    await delay(300);
    assert.equal(swState.groupedCalls.length, 0);

    swState.reset({
      tabs: [tab1, tab2],
      store: { tabtidy_settings: { autoGroup: true, minGroupSize: 2 } },
    });
    for (const fn of listeners.onTabUpdated) fn(10, { url: 'https://github.com/a' }, tab1);
    const chromeTab: MockTab = { ...tab1, url: 'chrome://settings/' };
    swState.tabs = [chromeTab, tab2];
    for (const fn of listeners.onTabUpdated) fn(10, { url: 'chrome://settings/' }, chromeTab);
    await delay(300);
    assert.equal(swState.groupedCalls.length, 0);

    swState.reset({
      tabs: [tab1, tab2],
      store: { tabtidy_settings: { autoGroup: true, minGroupSize: 2 } },
      onStorageGet() {
        const live = swState.tabs.find((t) => t.id === 10);
        if (live) live.pinned = true;
      },
    });
    for (const fn of listeners.onTabUpdated) fn(10, { status: 'complete' }, tab1);
    await delay(300);
    assert.equal(swState.groupedCalls.length, 0);

    swState.reset({
      tabs: [{ ...tab1 }, { ...tab2 }],
      store: { tabtidy_settings: { autoGroup: true, minGroupSize: 2 } },
    });
    for (const fn of listeners.onTabUpdated) {
      fn(10, { status: 'complete' }, tab1);
      fn(11, { status: 'complete' }, tab2);
    }
    await delay(320);
    assert.equal(swState.groups.length, 1);
    assert.equal(swState.groups[0].title, 'github.com');
    assert.equal(swState.groupedCalls.length, 1);
  });

  it('passes minGroupSize and ignoreHashForDedup in handleCommand', async () => {
    swState.reset({
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          url: 'https://docs.example.com/guide#part1',
          title: 'Guide Part 1',
          pinned: false,
          groupId: -1,
          mockSignals: { headings: 'Guide Reference', bodyText: 'guide reference manual' },
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          url: 'https://docs.example.com/guide#part2',
          title: 'Guide Part 2',
          pinned: false,
          groupId: -1,
          mockSignals: { headings: 'Guide Reference', bodyText: 'guide reference manual' },
        },
      ],
      store: {
        tabtidy_settings: {
          minGroupSize: 3,
          ignoreHashForDedup: true,
          showBadge: true,
        },
      },
    });

    for (const fn of listeners.onCommand) fn('group-by-similarity');
    await delay(40);
    // With ignoreHashForDedup=true, tab 2 is flagged as duplicate -> '不要' group (1 group),
    // while minGroupSize=3 prevents single remaining tab 1 from forming a content group.
    assert.equal(swState.groups.length, 1);
    assert.equal(swState.groups[0].title, '不要');
    assert.deepEqual(swState.groupedCalls[0].tabIds, [2]);

    swState.reset({
      tabs: [
        { id: 1, windowId: 1, index: 0, url: 'https://a.example/page#1', pinned: false },
        { id: 2, windowId: 1, index: 1, url: 'https://a.example/page#2', pinned: false },
      ],
      store: { tabtidy_settings: { ignoreHashForDedup: true, showBadge: true } },
    });
    for (const fn of listeners.onCommand) fn('close-duplicates');
    await delay(40);
    assert.equal(swState.tabs.length, 1);
    assert.equal(swState.badgeTexts[swState.badgeTexts.length - 1], '1');
  });
});
