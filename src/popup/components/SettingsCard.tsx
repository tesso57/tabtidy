import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { ExtensionSettings } from '@/types/tab';

const STALE_MINUTE_OPTIONS = [
  { value: '30', label: '30分' },
  { value: '60', label: '1時間' },
  { value: '180', label: '3時間' },
  { value: '1440', label: '24時間' },
] as const;

type BooleanSettingKey =
  | 'includeStaleInUnnecessary'
  | 'collapseGroups'
  | 'autoGroup'
  | 'ignoreHashForDedup'
  | 'showBadge';

type SettingRow =
  | {
      kind: 'switch';
      id: string;
      key: BooleanSettingKey;
      label: string;
      toastOnToggle?: (checked: boolean) => string;
    }
  | {
      kind: 'select';
      id: string;
      label: string;
    };

const SETTING_ROWS: readonly SettingRow[] = [
  {
    kind: 'switch',
    id: 'setting-include-stale',
    key: 'includeStaleInUnnecessary',
    label: '未操作タブも「不要」に入れる',
  },
  {
    kind: 'select',
    id: 'setting-stale-minutes',
    label: '未操作とみなす時間',
  },
  {
    kind: 'switch',
    id: 'setting-collapse-groups',
    key: 'collapseGroups',
    label: 'グループ化時に折りたたむ',
  },
  {
    kind: 'switch',
    id: 'setting-auto-group',
    key: 'autoGroup',
    label: '新規タブを自動でサイト分類',
    toastOnToggle: (v) =>
      v ? '自動グループ化を有効にしました' : '自動グループ化を無効にしました',
  },
  {
    kind: 'switch',
    id: 'setting-ignore-hash',
    key: 'ignoreHashForDedup',
    label: '重複判定で #以降を無視',
  },
  {
    kind: 'switch',
    id: 'setting-show-badge',
    key: 'showBadge',
    label: 'アイコンにタブ数を表示',
  },
];

interface SettingsCardProps {
  settings: ExtensionSettings;
  onUpdateSetting: <K extends keyof ExtensionSettings>(
    key: K,
    value: ExtensionSettings[K],
    toastMsg?: string
  ) => void;
}

export const SettingsCard = memo(function SettingsCard({
  settings,
  onUpdateSetting,
}: SettingsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>設定</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col">
        {SETTING_ROWS.map((row, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === SETTING_ROWS.length - 1;

          return (
            <div
              key={row.id}
              className={cn(
                'flex items-center justify-between gap-2',
                row.kind === 'select' ? 'min-h-[38px]' : 'min-h-[36px]',
                isFirst ? 'pb-2' : isLast ? 'pt-2' : 'py-2',
                !isLast && 'border-b border-border'
              )}
            >
              <label
                htmlFor={row.id}
                className={row.kind === 'switch' ? 'cursor-pointer text-xs' : 'text-xs'}
              >
                {row.label}
              </label>
              {row.kind === 'switch' ? (
                <Switch
                  id={row.id}
                  checked={settings[row.key]}
                  onCheckedChange={(v) => onUpdateSetting(row.key, v, row.toastOnToggle?.(v))}
                />
              ) : (
                <Select
                  id={row.id}
                  value={String(settings.staleMinutes)}
                  options={STALE_MINUTE_OPTIONS}
                  onValueChange={(v) => onUpdateSetting('staleMinutes', Number(v))}
                />
              )}
            </div>
          );
        })}

        <p className="pt-2 text-[11px] text-muted-foreground">
          ピン留め・入力中・音声再生中のタブは「不要」に入れません。
        </p>
      </CardContent>
    </Card>
  );
});
