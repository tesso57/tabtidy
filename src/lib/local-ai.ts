export type LocalLlmAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported'
  | 'error';

type LocalLlmApiKind = 'LanguageModel' | 'ai.languageModel' | 'none';

export interface LocalAiStatus {
  readonly llm: {
    readonly availability: LocalLlmAvailability;
    readonly apiKind: LocalLlmApiKind;
    readonly rawStatus: string;
    readonly detail?: string;
  };
  readonly segmenter: {
    readonly available: boolean;
  };
  readonly checkedAt: number;
}

interface LanguageModelModality {
  readonly type: 'text';
  readonly languages: readonly string[];
}

interface LanguageModelOptions {
  readonly expectedInputs: readonly LanguageModelModality[];
  readonly expectedOutputs: readonly LanguageModelModality[];
}

const LANGUAGE_MODEL_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
  expectedOutputs: [{ type: 'text', languages: ['ja'] }],
} as const satisfies LanguageModelOptions;

interface LanguageModelDownloadMonitor {
  readonly addEventListener: (
    type: string,
    cb: (event: { readonly loaded?: number; readonly total?: number }) => void
  ) => void;
}

interface LanguageModelCreateOptions extends LanguageModelOptions {
  readonly monitor?: (monitor: LanguageModelDownloadMonitor) => void;
}

interface ModernLanguageModelSession {
  readonly destroy?: () => void;
}

interface ModernLanguageModelApi {
  readonly availability?: (options?: LanguageModelOptions) => Promise<string>;
  readonly create?: (options?: LanguageModelCreateOptions) => Promise<ModernLanguageModelSession>;
}

interface LegacyAiApi {
  readonly languageModel?: {
    readonly capabilities?: () => Promise<{ readonly available?: string }>;
    readonly create?: () => Promise<ModernLanguageModelSession>;
  };
}

interface LocalAiEnvironment {
  readonly LanguageModel?: ModernLanguageModelApi;
  readonly ai?: LegacyAiApi;
  readonly hasSegmenter?: boolean;
}

const AVAILABILITY_MAP = new Map<string, LocalLlmAvailability>([
  ['available', 'available'],
  ['readily', 'available'],
  ['downloadable', 'downloadable'],
  ['after-download', 'downloadable'],
  ['downloading', 'downloading'],
  ['unavailable', 'unavailable'],
  ['no', 'unavailable'],
]);

function normalizeAvailability(raw: unknown): LocalLlmAvailability {
  const val = typeof raw === 'string' ? raw.toLowerCase() : '';
  return AVAILABILITY_MAP.get(val) ?? 'unavailable';
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function readProperty<K extends string>(target: unknown, key: K): unknown {
  if (!isObjectLike(target)) return undefined;
  const hasKey = (obj: object): obj is Record<K, unknown> => key in obj;
  return hasKey(target) ? target[key] : undefined;
}

function readMethod(
  target: unknown,
  key: string
): ((...args: unknown[]) => unknown) | null {
  const prop = readProperty(target, key);
  if (typeof prop !== 'function') return null;
  return (...args: unknown[]): unknown => Reflect.apply(prop, target, args);
}

function buildStatus(llm: LocalAiStatus['llm'], hasSegmenter: boolean): LocalAiStatus {
  return {
    llm,
    segmenter: { available: hasSegmenter },
    checkedAt: Date.now(),
  };
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

async function detectWithProvider(
  apiKind: Exclude<LocalLlmApiKind, 'none'>,
  probe: () => Promise<unknown>,
  hasSegmenter: boolean
): Promise<LocalAiStatus> {
  try {
    const raw = await probe();
    return buildStatus(
      {
        availability: normalizeAvailability(raw),
        apiKind,
        rawStatus: String(raw),
      },
      hasSegmenter
    );
  } catch (err) {
    return buildStatus(
      {
        availability: 'error',
        apiKind,
        rawStatus: 'error',
        detail: toErrorMessage(err),
      },
      hasSegmenter
    );
  }
}

export async function detectLocalAiStatus(env?: LocalAiEnvironment): Promise<LocalAiStatus> {
  const hasSegmenter =
    env?.hasSegmenter ??
    (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function');

  const source: unknown = env ?? globalThis;
  const lm = readProperty(source, 'LanguageModel');
  const checkModern = readMethod(lm, 'availability');
  if (checkModern) {
    return detectWithProvider(
      'LanguageModel',
      () => Promise.resolve(checkModern(LANGUAGE_MODEL_OPTIONS)),
      hasSegmenter
    );
  }

  const legacy = readProperty(readProperty(source, 'ai'), 'languageModel');
  const checkLegacy = readMethod(legacy, 'capabilities');
  if (checkLegacy) {
    return detectWithProvider(
      'ai.languageModel',
      async () => readProperty(await Promise.resolve(checkLegacy()), 'available') ?? 'no',
      hasSegmenter
    );
  }

  return buildStatus(
    {
      availability: 'unsupported',
      apiKind: 'none',
      rawStatus: 'unsupported',
    },
    hasSegmenter
  );
}

function toProgressPercent(event: unknown): number {
  const loaded = readProperty(event, 'loaded');
  if (typeof loaded !== 'number' || !Number.isFinite(loaded)) return 0;
  const total = readProperty(event, 'total');
  const ratio =
    typeof total === 'number' && Number.isFinite(total) && total > 1 ? loaded / total : loaded;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

async function warmSession(createSession: () => unknown): Promise<void> {
  let session: unknown = null;
  try {
    session = await Promise.resolve(createSession());
  } finally {
    if (session != null) {
      try {
        await Promise.resolve(readMethod(session, 'destroy')?.());
      } catch {
        // Ignore cleanup errors from temporary probe session
      }
    }
  }
}

export async function prepareLocalModel(
  onProgress?: (percent: number) => void,
  env?: LocalAiEnvironment
): Promise<LocalAiStatus> {
  const source: unknown = env ?? globalThis;
  const lm = readProperty(source, 'LanguageModel');
  const modernCreate = readMethod(lm, 'create');

  if (modernCreate) {
    await warmSession(() =>
      modernCreate({
        ...LANGUAGE_MODEL_OPTIONS,
        monitor(m: unknown) {
          const addEventListener = readMethod(m, 'addEventListener');
          addEventListener?.('downloadprogress', (e: unknown) => {
            onProgress?.(toProgressPercent(e));
          });
        },
      })
    );
  } else {
    const legacy = readProperty(readProperty(source, 'ai'), 'languageModel');
    const legacyCreate = readMethod(legacy, 'create');
    if (legacyCreate) {
      await warmSession(() => legacyCreate());
    }
  }

  return detectLocalAiStatus(env);
}
