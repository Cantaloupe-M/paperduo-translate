// GROBID rectangles already use the displayed page's top-left PDF coordinates.
// Scale each rectangle independently; never union wrapped lines or columns.
export function rectangleForViewport(box, page, viewport) {
  if (!page?.width || !page?.height) return null;
  const left = Math.max(0, box.x / page.width * viewport.width);
  const top = Math.max(0, box.y / page.height * viewport.height);
  const right = Math.min(viewport.width, (box.x + box.width) / page.width * viewport.width);
  const bottom = Math.min(viewport.height, (box.y + box.height) / page.height * viewport.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function segmentsOnPage(segments, page) {
  return segments.filter((segment) => segment.boxes.some((box) => box.page === page));
}
