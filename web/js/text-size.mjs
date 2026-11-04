// Adjustable translation font size, remembered across reloads when storage is available.
const KEY = 'paperduo-text-size';
export const SIZES = { min: 12, max: 26, step: 1, fallback: 16 };

export const clampSize = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return SIZES.fallback;
  return Math.min(SIZES.max, Math.max(SIZES.min, Math.round(number)));
};

export function setupTextSize({ target, out, grow, value, storage = globalThis.localStorage }) {
  const read = () => { try { return storage.getItem(KEY); } catch { return null; } };
  const write = (size) => { try { storage.setItem(KEY, size); } catch { /* Optional. */ } };
  const saved = read();
  let size = saved === null ? SIZES.fallback : clampSize(saved);

  function apply(next, persist = true) {
    size = clampSize(next);
    target.style.setProperty('--translation-size', `${size}px`);
    value.textContent = `${size}`;
    out.disabled = size <= SIZES.min;
    grow.disabled = size >= SIZES.max;
    if (persist) write(size);
    return size;
  }
  apply(size, false);
  return { apply, get size() { return size; }, shrink: () => apply(size - SIZES.step), grow: () => apply(size + SIZES.step), reset: () => apply(SIZES.fallback) };
}
