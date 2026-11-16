import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectLocalAiStatus, prepareLocalModel } from '../src/lib/local-ai.ts';

describe('detectLocalAiStatus', () => {
  it('detects modern LanguageModel availability states and specifies expectedOutputs', async () => {
    let receivedOptions: unknown = null;
    const ready = await detectLocalAiStatus({
      LanguageModel: {
        availability: async (opts) => {
          receivedOptions = opts;
          return 'available';
        },
      },
      hasSegmenter: true,
    });
    assert.equal(ready.llm.availability, 'available');
    assert.equal(ready.llm.apiKind, 'LanguageModel');
    assert.equal(ready.segmenter.available, true);
    assert.deepEqual(receivedOptions, {
      expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
      expectedOutputs: [{ type: 'text', languages: ['ja'] }],
    });

    const downloadable = await detectLocalAiStatus({
      LanguageModel: { availability: async () => 'downloadable' },
      hasSegmenter: true,
    });
    assert.equal(downloadable.llm.availability, 'downloadable');

    const unavailable = await detectLocalAiStatus({
      LanguageModel: { availability: async () => 'unavailable' },
      hasSegmenter: false,
    });
    assert.equal(unavailable.llm.availability, 'unavailable');
    assert.equal(unavailable.segmenter.available, false);
  });

  it('supports legacy ai.languageModel capabilities and unsupported environments', async () => {
    const legacy = await detectLocalAiStatus({
      ai: { languageModel: { capabilities: async () => ({ available: 'readily' }) } },
      hasSegmenter: true,
    });
    assert.equal(legacy.llm.availability, 'available');
    assert.equal(legacy.llm.apiKind, 'ai.languageModel');

    const unsupported = await detectLocalAiStatus({ hasSegmenter: true });
    assert.equal(unsupported.llm.availability, 'unsupported');
    assert.equal(unsupported.llm.apiKind, 'none');
  });

  it('reports errors cleanly and downloads/destroys temporary session on prepareLocalModel', async () => {
    const errored = await detectLocalAiStatus({
      LanguageModel: {
        availability: async () => {
          throw new Error('Blocked by policy');
        },
      },
      hasSegmenter: true,
    });
    assert.equal(errored.llm.availability, 'error');
    assert.equal(errored.llm.detail, 'Blocked by policy');

    let destroyed = false;
    let currentState = 'downloadable';
    let createOutputs: unknown = null;
    const progressValues: number[] = [];

    const next = await prepareLocalModel((pct) => progressValues.push(pct), {
      LanguageModel: {
        availability: async () => currentState,
        create: async (opts) => {
          createOutputs = opts?.expectedOutputs;
          opts?.monitor?.({
            addEventListener: (_type, cb) => {
              cb({ loaded: 0.5 });
              cb({ loaded: 1 });
            },
          });
          currentState = 'available';
          return {
            destroy: () => {
              destroyed = true;
            },
          };
        },
      },
    });

    assert.equal(destroyed, true);
    assert.deepEqual(createOutputs, [{ type: 'text', languages: ['ja'] }]);
    assert.deepEqual(progressValues, [50, 100]);
    assert.equal(next.llm.availability, 'available');
  });

  it('supports function-typed LanguageModel constructors via globalThis and sanitizes non-finite progress', async () => {
    function FakeLanguageModel() {}
    let availabilityThis: unknown = null;
    let createThis: unknown = null;
    const progressValues: number[] = [];

    FakeLanguageModel.availability = async function availability(this: unknown) {
      availabilityThis = this;
      return 'after-download';
    };
    FakeLanguageModel.create = async function create(
      this: unknown,
      opts?: {
        monitor?: (m: {
          addEventListener: (type: string, cb: (e: { loaded?: number }) => void) => void;
        }) => void;
      }
    ) {
      createThis = this;
      opts?.monitor?.({
        addEventListener: (_type, cb) => {
          cb({ loaded: Number.NaN });
          cb({ loaded: 1.5 });
        },
      });
      return { destroy: () => {} };
    };

    const prevLm = Reflect.get(globalThis, 'LanguageModel');
    const hadLm = Object.hasOwn(globalThis, 'LanguageModel');
    Reflect.set(globalThis, 'LanguageModel', FakeLanguageModel);

    try {
      const detected = await detectLocalAiStatus();
      assert.equal(detected.llm.availability, 'downloadable');
      assert.equal(availabilityThis, FakeLanguageModel);

      await prepareLocalModel((pct) => progressValues.push(pct));
      assert.equal(createThis, FakeLanguageModel);
      assert.deepEqual(progressValues, [0, 100]);
    } finally {
      if (hadLm) {
        Reflect.set(globalThis, 'LanguageModel', prevLm);
      } else {
        Reflect.deleteProperty(globalThis, 'LanguageModel');
      }
    }
  });

  it('handles legacy session cleanup, total-based progress, create failures, and null-prototype errors', async () => {
    let legacyDestroyed = false;
    const legacyStatus = await prepareLocalModel(undefined, {
      ai: {
        languageModel: {
          capabilities: async () => ({ available: 'readily' }),
          create: async () => ({
            destroy: async () => {
              legacyDestroyed = true;
            },
          }),
        },
      },
      hasSegmenter: true,
    });
    assert.equal(legacyDestroyed, true);
    assert.equal(legacyStatus.llm.availability, 'available');

    const byteProgress: number[] = [];
    await prepareLocalModel((pct) => byteProgress.push(pct), {
      LanguageModel: {
        availability: async () => 'available',
        create: async (opts) => {
          opts?.monitor?.({
            addEventListener: (_type, cb) => {
              cb({ loaded: 50, total: 200 });
              cb({ loaded: Number.POSITIVE_INFINITY, total: 200 });
              cb({ loaded: -0.2 });
            },
          });
          return {
            destroy: () => {
              throw new Error('cleanup failure should not break prepare');
            },
          };
        },
      },
    });
    assert.deepEqual(byteProgress, [25, 0, 0]);

    await assert.rejects(
      () =>
        prepareLocalModel(undefined, {
          LanguageModel: {
            availability: async () => 'downloadable',
            create: async () => {
              throw new Error('Download aborted');
            },
          },
        }),
      /Download aborted/
    );

    const nullProtoError = await detectLocalAiStatus({
      LanguageModel: {
        availability: async () => {
          throw Object.create(null);
        },
      },
      hasSegmenter: false,
    });
    assert.equal(nullProtoError.llm.availability, 'error');
    assert.equal(nullProtoError.llm.detail, 'Unknown error');

    const unsupportedStatus = await prepareLocalModel(undefined, { hasSegmenter: false });
    assert.equal(unsupportedStatus.llm.availability, 'unsupported');
  });
});
