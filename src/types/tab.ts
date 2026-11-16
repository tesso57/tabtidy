export type Scope = 'current' | 'all';
export type FilterKind = 'all' | 'duplicates' | 'ungrouped' | 'audible';

export type ChromeGroupColor =
  | 'blue'
  | 'cyan'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'pink'
  | 'purple'
  | 'red'
  | 'grey';

export interface TabLike {
  readonly id?: number;
  readonly windowId?: number;
  readonly index?: number;
  readonly url?: string;
  readonly pendingUrl?: string;
  readonly title?: string;
  readonly favIconUrl?: string;
  readonly pinned?: boolean;
  readonly active?: boolean;
  readonly audible?: boolean;
  readonly incognito?: boolean;
  readonly groupId?: number;
  readonly lastAccessed?: number;
}

export interface PageSignals {
  readonly title: string;
  readonly metaDesc: string;
  readonly headings: string;
  readonly bodyText: string;
  readonly hasFormDraft: boolean;
  readonly hasVideo: boolean;
}

export interface InspectedEntry {
  readonly tab: TabLike;
  readonly signals: Partial<PageSignals> | null;
}

export interface GroupPlan {
  readonly title: string;
  readonly color: ChromeGroupColor;
  readonly collapsed: boolean;
  readonly tabIds: readonly number[];
}

export interface ExtensionSettings {
  readonly autoGroup: boolean;
  readonly minGroupSize: number;
  readonly collapseGroups: boolean;
  readonly ignoreHashForDedup: boolean;
  readonly showBadge: boolean;
  readonly staleMinutes: number;
  readonly includeStaleInUnnecessary: boolean;
}

interface StashedTabItem {
  readonly title: string;
  readonly url: string;
  readonly favIconUrl: string;
}

export interface StashedSession {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly tabs: readonly StashedTabItem[];
}

interface UndoTabItem {
  readonly url: string;
  readonly title: string;
  readonly windowId?: number;
}

export interface UndoSnapshot {
  readonly closedAt: number;
  readonly tabs: readonly UndoTabItem[];
}

export interface TabSummary {
  readonly total: number;
  readonly pinned: number;
  readonly grouped: number;
  readonly ungrouped: number;
  readonly duplicates: number;
  readonly duplicateIds: ReadonlySet<number>;
}
