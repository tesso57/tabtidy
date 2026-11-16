import { Cpu, Download, RefreshCw } from 'lucide-react';
import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { LocalAiStatus, LocalLlmAvailability } from '@/lib/local-ai';
import { cn } from '@/lib/utils';

interface LlmStatusMeta {
  readonly label: string;
  readonly variant: 'success' | 'info' | 'warning' | 'secondary';
  readonly hint: string;
}

const LLM_STATUS_META = {
  available: {
    label: '利用可能',
    variant: 'success',
    hint: 'Gemini Nano がダウンロード済みで、ブラウザ内で動作可能な状態です。',
  },
  downloadable: {
    label: 'DL可能',
    variant: 'info',
    hint: 'この端末で利用できます。「準備」を押すとモデルをダウンロードします。',
  },
  downloading: {
    label: 'DL中',
    variant: 'warning',
    hint: 'Chrome がバックグラウンドで Gemini Nano をダウンロード中です。',
  },
  unavailable: {
    label: '利用不可',
    variant: 'secondary',
    hint: '端末スペック・空き容量またはポリシーによりローカル LLM を利用できません。',
  },
  error: {
    label: 'エラー',
    variant: 'warning',
    hint: 'モデルのステータス取得中にエラーが発生しました。',
  },
  unsupported: {
    label: '未対応',
    variant: 'secondary',
    hint: 'Prompt API (LanguageModel) が無効です。chrome://flags 等をご確認ください。',
  },
} satisfies Record<LocalLlmAvailability, LlmStatusMeta>;

const LOADING_STATUS_META: LlmStatusMeta = {
  label: '確認中',
  variant: 'secondary',
  hint: 'Chrome 内蔵モデルの利用可否を確認しています...',
};

interface LocalAiCardProps {
  status: LocalAiStatus | null;
  loading: boolean;
  downloadPct: number | null;
  error: string | null;
  onRefresh: () => void;
  onPrepare: () => void;
}

export const LocalAiCard = memo(function LocalAiCard({
  status,
  loading,
  downloadPct,
  error,
  onRefresh,
  onPrepare,
}: LocalAiCardProps) {
  const llm = status?.llm;
  const meta = llm ? LLM_STATUS_META[llm.availability] : LOADING_STATUS_META;
  const canDownload = llm?.availability === 'downloadable' && downloadPct === null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
          <span>ローカルモデル状態</span>
        </CardTitle>
        <Button
          variant="ghost"
          size="xs"
          disabled={loading}
          onClick={onRefresh}
          className="shrink-0"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          再確認
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex min-h-[30px] items-center justify-between gap-2 border-b border-border pb-2">
          <div className="min-w-0">
            <div className="text-xs font-medium">Chrome 内蔵 LLM (Gemini Nano)</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {llm ? `API: ${llm.apiKind} (${llm.rawStatus})` : '検出中...'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canDownload && (
              <Button variant="outline" size="xs" disabled={loading} onClick={onPrepare}>
                <Download className="h-3 w-3" />
                準備
              </Button>
            )}
            <Badge variant={meta.variant}>
              {downloadPct !== null ? `DL ${downloadPct}%` : meta.label}
            </Badge>
          </div>
        </div>

        <div className="flex min-h-[28px] items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium">日本語単語分割 (Intl.Segmenter)</div>
            <div className="text-[11px] text-muted-foreground">
              現在の類似度グルーピングで使用中
            </div>
          </div>
          <Badge
            variant={status?.segmenter.available ? 'success' : 'secondary'}
            className="shrink-0"
          >
            {status == null ? '確認中' : status.segmenter.available ? '利用可能' : 'フォールバック'}
          </Badge>
        </div>

        <p className="text-[11px] text-muted-foreground">
          {llm?.detail ? `${meta.hint} (${llm.detail})` : meta.hint}
        </p>

        {error && (
          <p
            role="alert"
            className="rounded-sm bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive break-words"
          >
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
});
