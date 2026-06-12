// ============================================================================
// availability.js — disponibilidad de largo plazo de un trabajador.
//
// worker.longAbsence = { code: 'BAJ'|'EX'|'LAC'|…, label, since: 'YYYY-MM-DD',
//                        until: 'YYYY-MM-DD' | null }  (null = hasta nuevo aviso)
//
// Un trabajador con ausencia indefinida activa NUNCA se propone como
// sustituto ni cuenta como disponible, independientemente de su planilla.
// ============================================================================

function isOnLongAbsence(worker, dateISO) {
  const a = worker?.longAbsence;
  if (!a || !a.code) return false;
  if (a.since && dateISO < a.since) return false;   // aún no ha empezado
  if (a.until && dateISO > a.until) return false;   // ya ha terminado
  return true;
}

module.exports = { isOnLongAbsence };
