import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZES, clampSize, setupTextSize } from '../../web/js/text-size.mjs';

const element = () => ({ disabled: false, textContent: '' });
const fixture = (initial) => {
  const data = new Map(initial === undefined ? [] : [['paperduo-text-size', initial]]);
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
  const target = { style: { props: {}, setProperty(k, v) { this.props[k] = v; } } };
  const [out, grow, value] = [element(), element(), element()];
  return { data, target, out, grow, value, control: setupTextSize({ target, out, grow, value, storage }) };
};

test('clamps invalid and out-of-range sizes', () => {
  assert.equal(clampSize('abc'), SIZES.fallback);
  assert.equal(clampSize(2), SIZES.min);
  assert.equal(clampSize(99), SIZES.max);
});

test('starts at the default size and applies it to the pane', () => {
  const { target, value } = fixture();
  assert.equal(target.style.props['--translation-size'], '16px');
  assert.equal(value.textContent, '16');
});

test('grows, shrinks, resets and remembers the size', () => {
  const { control, data, target } = fixture();
  control.grow(); control.grow();
  assert.equal(target.style.props['--translation-size'], '18px');
  assert.equal(data.get('paperduo-text-size'), '18');
  control.shrink();
  assert.equal(control.size, 17);
  control.reset();
  assert.equal(control.size, SIZES.fallback);
});

test('restores a saved size and disables buttons at the limits', () => {
  const small = fixture('12');
  assert.equal(small.control.size, 12);
  assert.equal(small.out.disabled, true);
  const large = fixture('26');
  assert.equal(large.grow.disabled, true);
});
