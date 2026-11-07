// Keep neighbouring sentences in the same paragraph together for context.
export function translationBatches(segments, limit = 24) {
  const batches = [];
  let group;
  for (const segment of segments) {
    const paragraph = segment.paragraph_id || segment.id;
    if (!batches.length || paragraph !== group || batches.at(-1).length >= limit) {
      batches.push([]);
      group = paragraph;
    }
    batches.at(-1).push(segment.id);
  }
  return batches;
}
