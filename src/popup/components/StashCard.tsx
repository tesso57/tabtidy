import { Archive, Clock, ExternalLink, Trash2 } from 'lucide-react';
import { memo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { StashedSession } from '@/types/tab';

function formatTime(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '--/-- --:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--/-- --:--';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface StashCardProps {
  stashLabel: string;
  staleCount: number;
  unpinnedCount: number;
  isBusy: boolean;
  sessions: readonly StashedSession[];
  onLabelChange: (label: string) => void;
  onStashStale: () => void;
  onStashAll: () => void;
  onRestoreSession: (sessionId: string, newWindow: boolean) => void;
  onDeleteSession: (sessionId: string) => void;
}

export const StashCard = memo(function StashCard({
  stashLabel,
  staleCount,
  unpinnedCount,
  isBusy,
  sessions,
  onLabelChange,
  onStashStale,
  onStashAll,
  onRestoreSession,
  onDeleteSession,
}: StashCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex min-w-0 items-center gap-1.5">
          <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">タブを退避（保存して閉じる）</span>
        </CardTitle>
        <Button
          variant="ghost"
          size="xs"
          disabled={staleCount === 0 || isBusy}
          onClick={onStashStale}
          className="shrink-0"
        >
          <Clock className="h-3 w-3" />
          未操作を退避 ({staleCount})
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex items-center gap-1.5">
          <Input
            value={stashLabel}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="メモ（省略可）"
            aria-label="退避セッションのメモ"
            maxLength={40}
          />
          <Button
            size="sm"
            disabled={unpinnedCount === 0 || isBusy}
            onClick={onStashAll}
            className="shrink-0"
          >
            すべて退避
          </Button>
        </div>

        <ul className="thin-scrollbar flex max-h-36 flex-col gap-1.5 overflow-y-auto">
          {sessions.length === 0 ? (
            <li className="py-4 text-center text-xs text-muted-foreground">
              退避されたセッションはありません
            </li>
          ) : (
            sessions.map((session) => {
              const sessionTabs = Array.isArray(session.tabs) ? session.tabs : [];
              return (
                <li
                  key={session.id}
                  className="flex flex-col gap-1 rounded-md border border-border bg-background p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold">
                      {session.name} ({sessionTabs.length}件)
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {formatTime(session.createdAt)}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {sessionTabs
                      .slice(0, 3)
                      .map((t) => t?.title || t?.url || '')
                      .filter(Boolean)
                      .join(' / ')}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={isBusy}
                      aria-label={`${session.name} をここに復元`}
                      onClick={() => onRestoreSession(session.id, false)}
                    >
                      ここに復元
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={isBusy}
                      aria-label={`${session.name} を別窓で復元`}
                      onClick={() => onRestoreSession(session.id, true)}
                    >
                      <ExternalLink className="h-3 w-3" />
                      別窓で復元
                    </Button>
                    <Button
                      variant="destructive"
                      size="xs"
                      disabled={isBusy}
                      aria-label={`${session.name} を削除`}
                      onClick={() => onDeleteSession(session.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                      削除
                    </Button>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </CardContent>
    </Card>
  );
});
