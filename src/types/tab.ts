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
  id?: number;
  windowId?: number;
  index?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  pinned?: boolean;
  active?: boolean;
  audible?: boolean;
  groupId?: number;
  lastAccessed?: number;
}

export interface PageSignals {
  title: string;
  metaDesc: string;
  headings: string;
  bodyText: string;
  hasFormDraft: boolean;
  hasVideo: boolean;
}

export interface InspectedEntry {
  tab: TabLike;
  signals: Partial<PageSignals> | null;
}

export interface GroupPlan {
  title: string;
  color: ChromeGroupColor;
  collapsed: boolean;
  tabIds: number[];
}

export interface ExtensionSettings {
  autoGroup: boolean;
  minGroupSize: number;
  collapseGroups: boolean;
  ignoreHashForDedup: boolean;
  showBadge: boolean;
  staleMinutes: number;
  includeStaleInUnnecessary: boolean;
}

interface StashedTabItem {
  title: string;
  url: string;
  favIconUrl: string;
}

export interface StashedSession {
  id: string;
  name: string;
  createdAt: number;
  tabs: StashedTabItem[];
}

export interface UndoSnapshot {
  closedAt: number;
  tabs: Array<{
    url: string;
    title: string;
    windowId?: number;
  }>;
}

export interface TabSummary {
  total: number;
  pinned: number;
  grouped: number;
  ungrouped: number;
  duplicates: number;
  duplicateIds: Set<number>;
}
