import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { ExtensionSettings } from '@/types/tab';

const STALE_MINUTE_OPTIONS = [
  { value: '30', label: '30分' },
  { value: '60', label: '1時間' },
  { value: '180', label: '3時間' },
  { value: '1440', label: '24時間' },
];

type BooleanSettingKey =
  | 'includeStaleInUnnecessary'
  | 'collapseGroups'
  | 'autoGroup'
  | 'ignoreHashForDedup'
  | 'showBadge';

interface SwitchSettingItem {
  id: string;
  key: BooleanSettingKey;
  label: string;
  toastOnToggle?: (checked: boolean) => string;
}

const SWITCH_SETTINGS: SwitchSettingItem[] = [
  {
    id: 'setting-include-stale',
    key: 'includeStaleInUnnecessary',
    label: '未操作タブも「不要」に入れる',
  },
  {
    id: 'setting-collapse-groups',
    key: 'collapseGroups',
    label: 'グループ化時に折りたたむ',
  },
  {
    id: 'setting-auto-group',
    key: 'autoGroup',
    label: '新規タブを自動でサイト分類',
    toastOnToggle: (v) =>
      v ? '自動グループ化を有効にしました' : '自動グループ化を無効にしました',
  },
  {
    id: 'setting-ignore-hash',
    key: 'ignoreHashForDedup',
    label: '重複判定で #以降を無視',
  },
  {
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

export function SettingsCard({ settings, onUpdateSetting }: SettingsCardProps) {
  const [firstToggle, ...remainingToggles] = SWITCH_SETTINGS;

  return (
    <Card>
      <CardHeader>
        <CardTitle>設定</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col">
        <div className="flex min-h-[36px] items-center justify-between gap-2 border-b border-border pb-2">
          <label htmlFor={firstToggle.id} className="cursor-pointer text-xs">
            {firstToggle.label}
          </label>
          <Switch
            id={firstToggle.id}
            checked={settings[firstToggle.key]}
            onCheckedChange={(v) => onUpdateSetting(firstToggle.key, v)}
          />
        </div>

        <div className="flex min-h-[38px] items-center justify-between gap-2 border-b border-border py-2">
          <label htmlFor="setting-stale-minutes" className="text-xs">
            未操作とみなす時間
          </label>
          <Select
            id="setting-stale-minutes"
            value={String(settings.staleMinutes)}
            options={STALE_MINUTE_OPTIONS}
            onValueChange={(v) => onUpdateSetting('staleMinutes', Number(v))}
          />
        </div>

        {remainingToggles.map((item, idx) => {
          const isLast = idx === remainingToggles.length - 1;
          return (
            <div
              key={item.key}
              className={
                isLast
                  ? 'flex min-h-[36px] items-center justify-between gap-2 pt-2'
                  : 'flex min-h-[36px] items-center justify-between gap-2 border-b border-border py-2'
              }
            >
              <label htmlFor={item.id} className="cursor-pointer text-xs">
                {item.label}
              </label>
              <Switch
                id={item.id}
                checked={settings[item.key]}
                onCheckedChange={(v) =>
                  onUpdateSetting(item.key, v, item.toastOnToggle?.(v))
                }
              />
            </div>
          );
        })}

        <p className="pt-2 text-[11px] text-muted-foreground">
          ピン留め・入力中・音声再生中のタブは「不要」に入れません。
        </p>
      </CardContent>
    </Card>
  );
}
