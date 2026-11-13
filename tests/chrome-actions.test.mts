import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  closeDuplicateTabs,
  getStashedSessions,
  groupTabsBySimilarity,
  restoreStashedSession,
  restoreUndoSnapshot,
  safeCloseTabs,
  stashTabs,
} from '../src/lib/chrome-actions.ts';

interface MockTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  title?: string;
  pinned: boolean;
  active?: boolean;
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

function createChromeMock(initialTabs: MockTab[] = [], initialGroups: MockGroup[] = []) {
  const store: Record<string, unknown> = {};
  let nextTabId = 100;
  let nextGroupId = 500;
  let tabs = initialTabs.map((t) => ({ ...t }));
  const groups = initialGroups.map((g) => ({ ...g }));
  const calls = {
    grouped: [] as Array<{ groupId?: number; createProperties?: { windowId: number }; tabIds: number[] }>,
    updatedGroups: [] as Array<{ groupId: number; props: Partial<MockGroup> }>,
    createdTabs: [] as MockTab[],
    removedTabs: [] as number[],
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: store[key] };
        },
        async set(obj: Record<string, unknown>) {
          Object.assign(store, obj);
        },
        async remove(key: string) {
          delete store[key];
        },
      },
    },
    windows: {
      async getCurrent() {
        return { id: 1 };
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
      async query(q: { windowId?: number } = {}) {
        return tabs.filter((t) => (q.windowId != null ? t.windowId === q.windowId : true));
      },
      async create({ windowId = 1, url = 'chrome://newtab/', active = false }) {
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
        calls.removedTabs.push(...list);
        tabs = tabs.filter((t) => !list.includes(t.id));
      },
      async group(opts: { groupId?: number; createProperties?: { windowId: number }; tabIds: number[] }) {
        if (opts.groupId && opts.createProperties) {
          throw new Error('Cannot specify both groupId and createProperties');
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
        const tab = tabs.find((t) => t.id === target.tabId);
        if (!tab || tab.scriptError) throw new Error('Cannot access tab');
        return [{ result: tab.mockSignals || null }];
      },
    },
  };

  return { getTabs: () => tabs, getGroups: () => groups, calls };
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
});
