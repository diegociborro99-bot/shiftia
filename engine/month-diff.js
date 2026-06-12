// ============================================================================
// computeMonthDiff — diff celda a celda entre el mes del backend (prev) y el
// mes entrante (nextRaw). Función pura, compartida por syncWorkerMonth
// (apply y dryRun). Normaliza: trim, mayúsculas, null/undefined → '', pad a 31.
// ============================================================================
function normalizeCell(c) {
  return c == null ? '' : String(c).trim().toUpperCase();
}

function computeMonthDiff(prev, nextRaw) {
  const prevArr = Array.isArray(prev) ? prev : [];
  const next = (Array.isArray(nextRaw) ? nextRaw : []).slice(0, 31).map(normalizeCell);
  while (next.length < 31) next.push('');

  const diff = [];
  for (let i = 0; i < 31; i++) {
    const a = normalizeCell(prevArr[i]);
    const b = next[i];
    if (a !== b) diff.push({ day: i, from: a, to: b });
  }
  const destructiveCount = diff.filter(d => d.from && !d.to).length;
  return { diff, next, destructiveCount };
}

module.exports = { computeMonthDiff };
