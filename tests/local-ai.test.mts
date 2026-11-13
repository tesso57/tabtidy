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
});
