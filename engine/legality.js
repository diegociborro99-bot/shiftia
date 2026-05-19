// ============================================================================
// Shiftia · Motor de legalidad (paridad con public/index.html:isLegalAssignment)
//
// Versión portada del motor v4.0 que vive en el cliente web. Se exporta como
// CommonJS para que el backend (routes/assistant.js) pueda usar EXACTAMENTE
// las mismas reglas que la web. Cualquier divergencia entre ambos = bug.
//
// API principal:
//   evaluateAssignment(workerId, dayIdx, shift, scheduleData, workers, year, month)
//     → { legal, reasons[], checks[{ rule, status, detail }] }
//
//   isLegalAssignment(...)   — versión simple legacy { legal, reason }
//   getCoverageRules(year, month, day, isFestivo)
//   getCoveringNow(scheduleData, workers, year, month, day, shift, targetPlanta)
//   getCrossMonthShift(scheduleData, workerId, year, month, direction)
//   isMorningShift(shift)
// ============================================================================

const RULES = {
  MAX_CONSECUTIVE_NIGHTS: 2,
  MIN_REST_HOURS: 12,
  ANNUAL_HOURS: 1519,
  NIGHT_COMPUTO_HOURS: 2.1,
  SHIFT_HOURS: { M:7, T:7, N:10, D:0, MR:5.5, VAC:0, LD:0, FOR:0, CAA:0, AE:0, EX:0, BAJ:0, CJ:0, FN:0, LAC:0, MTC:0, INT:0, HF:0, HS:0, VAA:0, DLA:0, M7H:7, M6R:6.5, M55:5, VAN:0, IQF:0, PM:0 },
  COVERAGE:          { M:{enf:3,tec:2}, T:{enf:1,tec:1}, N:{enf:1,tec:1} },
  COVERAGE_WEEKEND:  { M:{enf:1,tec:1}, T:{enf:1,tec:1}, N:{enf:1,tec:1} },
  COVERAGE_MICRO:         { M: 3 },
  COVERAGE_MICRO_WEEKEND: { M: 0 }
};

// Códigos de ausencia / no-trabajo (mismos que la web).
const UNAVAILABLE_CODES = ['VAC','VAA','VAN','BAJ','LD','LAC','FOR','CAA','AE','EX','MTC','INT','HF','HS','DLA','CJ','FN','IQF','PM'];

// Tras una NOCHE solo se admiten estos códigos (whitelist). Cualquier otro =
// descanso obligatorio violado.
const ALLOWED_AFTER_NIGHT = ['', 'D', 'N', ...UNAVAILABLE_CODES];

const MORNING_SHIFTS = ['M','MR','M7H','M6R','M55'];

function isMorningShift(shift) { return MORNING_SHIFTS.includes(shift); }

function ymKey(year, month) { return `${year}-${month}`; }

function getCrossMonthShift(scheduleData, workerId, year, month, direction) {
  let adjYear = year, adjMonth = month + direction;
  if (adjMonth < 0)  { adjMonth = 11; adjYear--; }
  if (adjMonth > 11) { adjMonth = 0;  adjYear++; }
  const adj = scheduleData?.[ymKey(adjYear, adjMonth)];
  if (!adj || !adj[workerId]) return '';
  if (direction === -1) {
    const lastIdx = adj[workerId].length - 1;
    return (adj[workerId][lastIdx] || '').toString().trim();
  }
  return (adj[workerId][0] || '').toString().trim();
}

function cellOf(scheduleData, year, month, workerId, day) {
  const arr = scheduleData?.[ymKey(year, month)]?.[workerId];
  if (!Array.isArray(arr) || day < 0 || day >= arr.length) return '';
  return (arr[day] || '').toString().trim();
}

// ============================================================================
// evaluateAssignment — devuelve TODOS los checks (pass/warning/fail), no solo
// los que fallan. Sirve para construir el array `reasoning` que ve la super.
// ============================================================================
function evaluateAssignment(workerId, dayIdx, shift, scheduleData, workers, year, month) {
  const checks = [];
  const reasons = [];
  let legal = true;

  const w = (workers || []).find(x => String(x.id) === String(workerId) || String(x.actaisId || '') === String(workerId));
  if (!w) {
    return { legal: false, reasons: ['Trabajador no encontrado'], checks: [{ rule: 'Identidad', status: 'fail', detail: 'Trabajador no encontrado en planillas' }] };
  }

  const sch = scheduleData?.[ymKey(year, month)]?.[w.id] || [];
  const current = cellOf(scheduleData, year, month, w.id, dayIdx);

  // 1. Restricciones individuales
  if (w.rules?.noNights && shift === 'N') {
    checks.push({ rule: 'Restricción individual: noches', status: 'fail', detail: 'Trabajador marcado noNights' });
    reasons.push('No puede hacer noches (noNights)'); legal = false;
  } else if (w.rules?.noNights) {
    checks.push({ rule: 'Restricción individual: noches', status: 'pass', detail: 'noNights pero el turno no es N' });
  }
  if (w.rules?.noSwap) {
    checks.push({ rule: 'Restricción individual: no sustituciones', status: 'fail', detail: 'Trabajador marcado noSwap' });
    reasons.push('No puede hacer sustituciones (noSwap)'); legal = false;
  }
  if (w.rules?.noCover) {
    checks.push({ rule: 'Restricción individual: no cubre', status: 'fail', detail: 'Trabajador marcado noCover' });
    reasons.push('No puede hacer coberturas (noCover)'); legal = false;
  }
  if (!w.rules?.noNights && !w.rules?.noSwap && !w.rules?.noCover) {
    checks.push({ rule: 'Restricciones individuales', status: 'pass', detail: 'Sin restricciones aplicables' });
  }

  // 2. Disponibilidad — ¿está libre ese día?
  if (UNAVAILABLE_CODES.includes(current)) {
    checks.push({ rule: 'Disponibilidad', status: 'fail', detail: `Día asignado a ${current} (ausencia / no-trabajo)` });
    reasons.push(`No disponible (${current})`); legal = false;
  } else if (current && current !== 'D') {
    checks.push({ rule: 'Disponibilidad', status: 'fail', detail: `Día ya asignado a turno ${current}` });
    reasons.push(`Ya asignado para ese día (${current})`); legal = false;
  } else {
    checks.push({ rule: 'Disponibilidad', status: 'pass', detail: current === 'D' ? 'Día actualmente en descanso (D)' : 'Día sin asignar' });
  }

  // 3. Noches consecutivas máximo (cross-month bidireccional)
  if (shift === 'N') {
    let before = 0, after = 0;
    for (let i = dayIdx - 1; i >= 0; i--) {
      if (cellOf(scheduleData, year, month, w.id, i) === 'N') before++; else break;
    }
    if (dayIdx === 0 && getCrossMonthShift(scheduleData, w.id, year, month, -1) === 'N') {
      before++;
      // Mira 2 días atrás cross-month
      let adjM = month - 1, adjY = year;
      if (adjM < 0) { adjM = 11; adjY--; }
      const adjSch = scheduleData?.[ymKey(adjY, adjM)];
      if (adjSch && adjSch[w.id]) {
        const li = adjSch[w.id].length - 2;
        if (li >= 0 && (adjSch[w.id][li] || '').toString().trim() === 'N') before++;
      }
    }
    for (let i = dayIdx + 1; i < sch.length; i++) {
      if (cellOf(scheduleData, year, month, w.id, i) === 'N') after++; else break;
    }
    if (dayIdx === sch.length - 1 && getCrossMonthShift(scheduleData, w.id, year, month, +1) === 'N') after++;
    const total = before + 1 + after;
    if (total > RULES.MAX_CONSECUTIVE_NIGHTS) {
      checks.push({ rule: 'Noches consecutivas', status: 'fail', detail: `Quedarían ${total} noches seguidas (${before}+1+${after}), tope ${RULES.MAX_CONSECUTIVE_NIGHTS}` });
      reasons.push(`Superaría ${RULES.MAX_CONSECUTIVE_NIGHTS} noches consecutivas`); legal = false;
    } else {
      checks.push({ rule: 'Noches consecutivas', status: 'pass', detail: `${total}/${RULES.MAX_CONSECUTIVE_NIGHTS} (${before} antes + 1 + ${after} después)` });
    }
  }

  // 4. Descanso post-noche (cross-month)
  if (dayIdx > 0) {
    const prev = cellOf(scheduleData, year, month, w.id, dayIdx - 1);
    if (prev === 'N' && (isMorningShift(shift) || shift === 'T')) {
      checks.push({ rule: 'Descanso post-noche', status: 'fail', detail: `Día anterior fue N → ${shift} prohibido (descanso obligatorio)` });
      reasons.push(`Día anterior es N → ${shift} prohibido`); legal = false;
    } else if (prev === 'N') {
      checks.push({ rule: 'Descanso post-noche', status: 'pass', detail: 'Día anterior fue N pero el turno es compatible' });
    } else if (shift && !['', 'D'].includes(shift)) {
      checks.push({ rule: 'Descanso post-noche', status: 'pass', detail: `Día anterior: ${prev || '∅'}` });
    }
  } else if (shift !== 'N' && shift !== 'D' && shift !== '') {
    const prevM = getCrossMonthShift(scheduleData, w.id, year, month, -1);
    if (prevM === 'N' && (isMorningShift(shift) || shift === 'T')) {
      checks.push({ rule: 'Descanso post-noche (cross-month)', status: 'fail', detail: `Último día mes anterior fue N → ${shift} prohibido` });
      reasons.push('Cross-month: último día mes anterior es N'); legal = false;
    }
  }

  // 5. WHITELIST de lo que puede ir tras una NOCHE (si shift = N, mira el día siguiente)
  if (shift === 'N') {
    // Encontrar fin del bloque N
    let endIdx = dayIdx;
    for (let i = dayIdx + 1; i < sch.length; i++) {
      if (cellOf(scheduleData, year, month, w.id, i) === 'N') endIdx = i; else break;
    }
    if (endIdx + 1 < sch.length) {
      const afterBlock = cellOf(scheduleData, year, month, w.id, endIdx + 1);
      if (afterBlock && !ALLOWED_AFTER_NIGHT.includes(afterBlock)) {
        checks.push({ rule: 'Whitelist post-noche', status: 'fail', detail: `Tras la N habría un ${afterBlock} (día ${endIdx + 2}), no permitido` });
        reasons.push(`N no puede ir seguido de ${afterBlock}`); legal = false;
      } else {
        checks.push({ rule: 'Whitelist post-noche', status: 'pass', detail: afterBlock ? `Tras la N: ${afterBlock} (permitido)` : 'Día siguiente vacío' });
      }
    }
    if (endIdx === sch.length - 1) {
      const nextM = getCrossMonthShift(scheduleData, w.id, year, month, +1);
      if (nextM && !ALLOWED_AFTER_NIGHT.includes(nextM)) {
        checks.push({ rule: 'Whitelist post-noche (cross-month)', status: 'fail', detail: `Mes siguiente arranca con ${nextM} tras tu noche` });
        reasons.push(`Cross-month: N seguida de ${nextM}`); legal = false;
      }
    }
  }

  // 6. Non-N tras N
  if (shift && shift !== 'N' && dayIdx > 0) {
    const prev = cellOf(scheduleData, year, month, w.id, dayIdx - 1);
    if (prev === 'N' && !ALLOWED_AFTER_NIGHT.includes(shift)) {
      checks.push({ rule: 'Whitelist tras N', status: 'fail', detail: `No se puede asignar ${shift} después de N` });
      reasons.push(`${shift} prohibido tras N`); legal = false;
    }
  }

  // 7. Máximo noches/mes (por trabajador o global)
  if (shift === 'N') {
    const nightCount = sch.filter(s => (s || '').toString().trim() === 'N').length;
    const max = (w.rules?.maxNightsPerMonth != null) ? w.rules.maxNightsPerMonth : 5;
    if (nightCount >= max) {
      checks.push({ rule: 'Noches por mes', status: 'fail', detail: `Tope alcanzado: ${nightCount}/${max}` });
      reasons.push(`Máximo noches/mes (${nightCount}/${max})`); legal = false;
    } else {
      checks.push({ rule: 'Noches por mes', status: 'pass', detail: `${nightCount}/${max} este mes` });
    }
  }

  return { legal, reasons: legal ? [] : reasons, checks };
}

// Wrapper estilo viejo para sustituir el checkLegality del backend.
function isLegalAssignment(workerId, dayIdx, shift, scheduleData, workers, year, month) {
  const r = evaluateAssignment(workerId, dayIdx, shift, scheduleData, workers, year, month);
  return { legal: r.legal, reasons: r.reasons };
}

// ============================================================================
// Roles y plantas — Mapeo de strings que vienen del PDF/Actais al modelo
// interno del motor (enf|tec|micro).
//   DUE        → 'enf' (enfermera/enfermero)
//   TECNICO    → 'tec' (técnico de laboratorio o similar)
//   MICRO*     → 'micro' (microbiología)
// Si la role no encaja, devolvemos 'enf' por defecto (la mayoría).
// ============================================================================
function roleOf(worker) {
  const r = (worker?.role || '').toString().toUpperCase().trim();
  if (!r) return null;
  if (r === 'DUE' || r === 'ENF' || r.startsWith('ENFERM')) return 'enf';
  if (r === 'TECNICO' || r === 'TÉCNICO' || r === 'TEC' || r.startsWith('TEC')) return 'tec';
  if (r.includes('MICRO')) return 'micro';
  return null;
}

// ¿Es la planta de Microbiología? Acepta variantes con/sin tilde.
function isMicroPlanta(planta) {
  return /micro/i.test(String(planta || ''));
}

function isWeekendOrHoliday(year, month, day, isFestivo) {
  const dow = new Date(year, month, day).getDay();
  return dow === 0 || dow === 6 || (typeof isFestivo === 'function' && isFestivo(year, month, day));
}

// ============================================================================
// getRequiredCoverage — cuántos trabajadores del MISMO ROL hacen falta para
// CUBRIR un (planta, role, shift, día). Replica RULES.COVERAGE de la web.
//
// Por planta:
//   MICROBIOLOGIA → solo M: 3 entre semana, 0 fin de semana
//   resto (HEMATOLOGIA, etc.):
//     M: 3 enf + 2 tec entre semana; 1 enf + 1 tec fin de semana
//     T: 1 enf + 1 tec siempre
//     N: 1 enf + 1 tec siempre
// ============================================================================
function getRequiredCoverage(planta, role, year, month, day, isFestivo) {
  const isWE = isWeekendOrHoliday(year, month, day, isFestivo);
  if (isMicroPlanta(planta)) {
    const tbl = isWE ? RULES.COVERAGE_MICRO_WEEKEND : RULES.COVERAGE_MICRO;
    return { M: tbl.M || 0, T: 0, N: 0 };
  }
  const tbl = isWE ? RULES.COVERAGE_WEEKEND : RULES.COVERAGE;
  const r = role || 'enf';
  return {
    M: tbl.M?.[r] ?? 0,
    T: tbl.T?.[r] ?? 0,
    N: tbl.N?.[r] ?? 0
  };
}

function getRequiredForShift(planta, role, shift, year, month, day, isFestivo) {
  const cov = getRequiredCoverage(planta, role, year, month, day, isFestivo);
  return cov[shift] ?? 0;
}

// Cobertura — cuántos trabajadores del MISMO ROL cubren ya un turno X en la
// planta del worker. Filtra por planta Y por rol — un técnico no cuenta para
// cubrir a una DUE y viceversa.
function getCoveringNow(scheduleData, workers, year, month, day, shift, targetPlanta, targetRole) {
  const monthSchedules = scheduleData?.[ymKey(year, month)] || {};
  let count = 0;
  for (const wId of Object.keys(monthSchedules)) {
    const arr = monthSchedules[wId] || [];
    if (arr[day] !== shift) continue;
    const w = (workers || []).find(x => String(x.id) === String(wId));
    if (!w) continue;
    if (w.planta !== targetPlanta) continue;
    if (targetRole && roleOf(w) !== targetRole) continue;
    count++;
  }
  return count;
}

// Reglas de cobertura según día de semana / festivo (compat con código viejo).
function getCoverageRules(year, month, day, isFestivo) {
  const isWE = isWeekendOrHoliday(year, month, day, isFestivo);
  return isWE ? RULES.COVERAGE_WEEKEND : RULES.COVERAGE;
}

function getMicroCoverageRules(year, month, day, isFestivo) {
  const isWE = isWeekendOrHoliday(year, month, day, isFestivo);
  return isWE ? RULES.COVERAGE_MICRO_WEEKEND : RULES.COVERAGE_MICRO;
}

module.exports = {
  RULES,
  UNAVAILABLE_CODES,
  ALLOWED_AFTER_NIGHT,
  isMorningShift,
  getCrossMonthShift,
  cellOf,
  evaluateAssignment,
  isLegalAssignment,
  getCoveringNow,
  getCoverageRules,
  getMicroCoverageRules,
  getRequiredCoverage,
  getRequiredForShift,
  roleOf,
  isMicroPlanta,
  isWeekendOrHoliday
};
