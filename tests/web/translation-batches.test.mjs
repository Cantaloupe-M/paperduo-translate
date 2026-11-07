import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translationBatches } from '../../web/js/translation-batches.mjs';

test('groups adjacent sentences by paragraph and limits oversized paragraphs', () => {
  const segments = [
    ...Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, paragraph_id: 'a' })),
    { id: 'b1', paragraph_id: 'b' }, { id: 'b2', paragraph_id: 'b' },
    { id: 'heading' },
  ];
  const batches = translationBatches(segments);
  assert.deepEqual(batches.map((batch) => batch.length), [24, 1, 2, 1]);
  assert.deepEqual(batches.flat(), segments.map((segment) => segment.id));
});
