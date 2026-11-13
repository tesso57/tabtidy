export type LocalLlmAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported'
  | 'error';

export type LocalLlmApiKind = 'LanguageModel' | 'ai.languageModel' | 'none';

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

interface ModernLanguageModelSession {
  destroy?: () => void;
}

interface ModernLanguageModelApi {
  availability?: (options?: Record<string, unknown>) => Promise<string>;
  create?: (options?: {
    monitor?: (m: { addEventListener: (type: string, cb: (e: { loaded?: number }) => void) => void }) => void;
  }) => Promise<ModernLanguageModelSession>;
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
    try {
      const raw = await lm.availability();
      return {
        llm: {
          availability: normalizeAvailability(raw),
          apiKind: 'LanguageModel',
          rawStatus: String(raw),
        },
        segmenter: { available: hasSegmenter },
        checkedAt: Date.now(),
      };
    } catch (err) {
      return {
        llm: {
          availability: 'error',
          apiKind: 'LanguageModel',
          rawStatus: 'error',
          detail: err instanceof Error ? err.message : String(err),
        },
        segmenter: { available: hasSegmenter },
        checkedAt: Date.now(),
      };
    }
  }

  const legacy = env.ai?.languageModel;
  if (legacy && typeof legacy.capabilities === 'function') {
    try {
      const caps = await legacy.capabilities();
      const raw = caps?.available ?? 'no';
      return {
        llm: {
          availability: normalizeAvailability(raw),
          apiKind: 'ai.languageModel',
          rawStatus: String(raw),
        },
        segmenter: { available: hasSegmenter },
        checkedAt: Date.now(),
      };
    } catch (err) {
      return {
        llm: {
          availability: 'error',
          apiKind: 'ai.languageModel',
          rawStatus: 'error',
          detail: err instanceof Error ? err.message : String(err),
        },
        segmenter: { available: hasSegmenter },
        checkedAt: Date.now(),
      };
    }
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
