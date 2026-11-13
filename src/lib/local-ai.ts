export type LocalLlmAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported'
  | 'error';

type LocalLlmApiKind = 'LanguageModel' | 'ai.languageModel' | 'none';

export interface LocalAiStatus {
  llm: {
    availability: LocalLlmAvailability;
    apiKind: LocalLlmApiKind;
    rawStatus: string;
    detail?: string;
  };
  segmenter: {
    available: boolean;
  };
  checkedAt: number;
}

interface LanguageModelModality {
  type: 'text';
  languages: string[];
}

const LANGUAGE_MODEL_OPTIONS: {
  expectedInputs: LanguageModelModality[];
  expectedOutputs: LanguageModelModality[];
} = {
  expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
  expectedOutputs: [{ type: 'text', languages: ['ja'] }],
};

interface ModernLanguageModelSession {
  destroy?: () => void;
}

interface ModernLanguageModelApi {
  availability?: (options?: typeof LANGUAGE_MODEL_OPTIONS) => Promise<string>;
  create?: (
    options?: typeof LANGUAGE_MODEL_OPTIONS & {
      monitor?: (m: {
        addEventListener: (type: string, cb: (e: { loaded?: number }) => void) => void;
      }) => void;
    }
  ) => Promise<ModernLanguageModelSession>;
}

interface LegacyAiApi {
  languageModel?: {
    capabilities?: () => Promise<{ available?: string }>;
    create?: () => Promise<ModernLanguageModelSession>;
  };
}

function normalizeAvailability(raw: unknown): LocalLlmAvailability {
  const val = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (val === 'available' || val === 'readily') return 'available';
  if (val === 'downloadable' || val === 'after-download') return 'downloadable';
  if (val === 'downloading') return 'downloading';
  if (val === 'unavailable' || val === 'no') return 'unavailable';
  return 'unavailable';
}

async function detectWithProvider(
  apiKind: Exclude<LocalLlmApiKind, 'none'>,
  probe: () => Promise<string>,
  hasSegmenter: boolean
): Promise<LocalAiStatus> {
  try {
    const raw = await probe();
    return {
      llm: {
        availability: normalizeAvailability(raw),
        apiKind,
        rawStatus: String(raw),
      },
      segmenter: { available: hasSegmenter },
      checkedAt: Date.now(),
    };
  } catch (err) {
    return {
      llm: {
        availability: 'error',
        apiKind,
        rawStatus: 'error',
        detail: err instanceof Error ? err.message : String(err),
      },
      segmenter: { available: hasSegmenter },
      checkedAt: Date.now(),
    };
  }
}

export async function detectLocalAiStatus(
  env: {
    LanguageModel?: ModernLanguageModelApi;
    ai?: LegacyAiApi;
    hasSegmenter?: boolean;
  } = globalThis as unknown as {
    LanguageModel?: ModernLanguageModelApi;
    ai?: LegacyAiApi;
  }
): Promise<LocalAiStatus> {
  const hasSegmenter =
    env.hasSegmenter ??
    (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function');

  const lm = env.LanguageModel;
  if (lm && typeof lm.availability === 'function') {
    const checkModern = lm.availability.bind(lm);
    return detectWithProvider(
      'LanguageModel',
      () => checkModern(LANGUAGE_MODEL_OPTIONS),
      hasSegmenter
    );
  }

  const legacy = env.ai?.languageModel;
  if (legacy && typeof legacy.capabilities === 'function') {
    const checkLegacy = legacy.capabilities.bind(legacy);
    return detectWithProvider(
      'ai.languageModel',
      async () => (await checkLegacy())?.available ?? 'no',
      hasSegmenter
    );
  }

  return {
    llm: {
      availability: 'unsupported',
      apiKind: 'none',
      rawStatus: 'unsupported',
    },
    segmenter: { available: hasSegmenter },
    checkedAt: Date.now(),
  };
}

export async function prepareLocalModel(
  onProgress?: (percent: number) => void,
  env: {
    LanguageModel?: ModernLanguageModelApi;
    ai?: LegacyAiApi;
  } = globalThis as unknown as {
    LanguageModel?: ModernLanguageModelApi;
    ai?: LegacyAiApi;
  }
): Promise<LocalAiStatus> {
  if (env.LanguageModel && typeof env.LanguageModel.create === 'function') {
    const session = await env.LanguageModel.create({
      ...LANGUAGE_MODEL_OPTIONS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.min(100, Math.max(0, Math.round((e.loaded ?? 0) * 100)));
          onProgress?.(pct);
        });
      },
    });
    session?.destroy?.();
  } else if (env.ai?.languageModel && typeof env.ai.languageModel.create === 'function') {
    const session = await env.ai.languageModel.create();
    session?.destroy?.();
  }

  return detectLocalAiStatus(env);
}
