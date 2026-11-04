import test from 'node:test';
import assert from 'node:assert/strict';
import { rectangleForViewport, segmentsOnPage } from '../../web/js/alignment.mjs';

function assertRectangle(actual, expected) {
  for (const key of ['left', 'top', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6, `${key}: ${actual[key]} != ${expected[key]}`);
  }
}

test('two wrapped lines remain separate and scale with the PDF canvas', () => {
  const page = { width: 600, height: 800 };
  const boxes = [{ page: 1, x: 50, y: 100, width: 200, height: 10 },
    { page: 1, x: 50, y: 115, width: 80, height: 10 }];
  const rects = boxes.map((box) => rectangleForViewport(box, page, { width: 1200, height: 1600 }));
  assert.equal(rects.length, 2);
  assertRectangle(rects[0], { left: 100, top: 200, width: 400, height: 20 });
  assertRectangle(rects[1], { left: 100, top: 230, width: 160, height: 20 });
});

test('a sentence crossing pages retains the same id on both pages', () => {
  const segment = { id: 'same-id', boxes: [{ page: 1 }, { page: 2 }] };
  assert.equal(segmentsOnPage([segment], 1)[0], segment);
  assert.equal(segmentsOnPage([segment], 2)[0], segment);
  assert.deepEqual(segmentsOnPage([segment], 3), []);
});

test('coordinates outside the visible page are clipped', () => {
  assertRectangle(rectangleForViewport({ x: -5, y: 100, width: 20, height: 10 },
    { width: 600, height: 800 }, { width: 600, height: 800 }), { left: 0, top: 100, width: 15, height: 10 });
  assert.equal(rectangleForViewport({ x: 700, y: 100, width: 20, height: 10 },
    { width: 600, height: 800 }, { width: 600, height: 800 }), null);
});
