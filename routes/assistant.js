const express = require('express');
const { matchWorker } = require('../engine/name-matcher');
const engine = require('../engine/legality');
const { computeMonthDiff } = require('../engine/month-diff');

// ============================================================================
// Shiftia Assistant — endpoints deterministas (sin LLM, sin coste por consulta)
//
// Para garantizar paridad con el motor de la web, las reglas viven en
// engine/legality.js. Aquí solo orquestamos: cargar data, resolver worker,
// invocar engine.evaluateAssignment(), construir respuesta.
//
// Cada endpoint devuelve un shape uniforme:
//   { ok, summary: {action,who,when,what,where}, verdict: 'ok'|'warning'|'blocked',
//     verdictLabel, reasoning: [{rule,status,detail}], …payload acción específica }
// ============================================================================

const SP_RULES = {
  maxNightsPerMonth: 2,
  maxConsecutiveDays: 6,
  minWeeklyRestDays: 1
};

const PLANT_NAMES = {
  p1n: '1º Norte', p2n: '2º Norte', p2e: '2º Este', p3e: '3º Este',
  endo: 'Endoscopias', urg: 'Urgencias', refuerzo: 'Refuerzo'
};

const PLANT_COVERAGE = {
  p1n: { M: 2, T: 2, N: 2 }, p2n: { M: 2, T: 2, N: 2 },
  p2e: { M: 2, T: 2, N: 2 }, p3e: { M: 2, T: 2, N: 2 },
  endo: { M: 2, T: 2, N: 0 }, urg: { M: 3, T: 3, N: 2 },
  refuerzo: { M: 0, T: 0, N: 0 }
};

const SHIFT_CODES = ['M', 'T', 'N'];

// ===== Helpers =====
function ymKey(year, month) { return `${year}-${month}`; }
function cellOf(data, year, month, wId, day) {
  const arr = data?.scheduleData?.[ymKey(year, month)]?.[wId];
  if (!Array.isArray(arr) || day < 0 || day >= arr.length) return '';
  return arr[day] ?? '';
}
function workerById(data, id) {
  const all = (data?.workerMeta || data?.workers || []);
  // Match by id (legacy SARA autoincrement) OR by actaisId (cross-ref with Actais hospital ID)
  return all.find(w => String(w.id) === String(id) || String(w.actaisId || '') === String(id));
}
function getEffectivePlanta(data, wId, year, month, day) {
  const override = data?.crossPlantAssignments?.[ymKey(year, month)]?.[wId]?.[day];
  if (override) return override;
  return workerById(data, wId)?.planta || null;
}

// ===== Legality (delega en engine/legality.js — paridad con la web) =====
// La función legacy `checkLegality` solo evaluaba 5 reglas. Ahora delegamos
// al motor portado que evalúa 7 reglas con cross-month + whitelist post-noche.
// Cualquier sitio del código que llamaba a checkLegality(data, worker, year, month, day, shift)
// sigue funcionando — devuelve { legal, reasons }.
function checkLegality(data, worker, year, month, day, shift) {
  if (!worker) return { legal: false, reasons: ['Trabajador no encontrado'] };
  const workers = data?.workerMeta || data?.workers || [];
  return engine.isLegalAssignment(worker.id, day, shift, data?.scheduleData || {}, workers, year, month);
}

// evaluateFull — devuelve TODOS los checks (pass/fail), incluso los que pasan,
// para construir el array de razonamiento que ve la supervisora.
function evaluateFull(data, worker, year, month, day, shift) {
  if (!worker) return { legal: false, reasons: ['Trabajador no encontrado'], checks: [] };
  const workers = data?.workerMeta || data?.workers || [];
  return engine.evaluateAssignment(worker.id, day, shift, data?.scheduleData || {}, workers, year, month);
}

// ============================================================================
// Constructores del shape uniforme de respuesta.
// ============================================================================
// Catálogo de códigos de ausencia / no-trabajo + etiqueta legible.
// Categorías: Largo (semanas+), Corto (1-3 días), Variable.
const ABSENCE_LABELS = {
  VAC: 'Vacaciones',
  VAA: 'Vacaciones año anterior',
  VAN: 'Vacaciones arrastradas',
  LAC: 'Lactancia',
  EX:  'Excedencia',
  BAJ: 'Baja médica',
  FOR: 'Formación',
  LD:  'Libre disposición',
  AE:  'Asuntos propios',
  PM:  'Permiso',
  MTC: 'Motivo familiar',
  CJ:  'Cómputo jornada'
};

const ACTION_LABELS = {
  librar:           { title: 'Librar día',           what: 'Convertir turno actual en descanso' },
  vacaciones:       { title: 'Marcar vacaciones',    what: 'Asignar VAC a los días indicados' },
  cambio:           { title: 'Proponer cambio',      what: 'Intercambiar turno con un compañero' },
  whoCovers:        { title: 'Buscar sustituto',     what: 'Sugerir candidatos para cubrir' },
  validateConvenio: { title: 'Validar convenio',     what: 'Comprobar legalidad de asignación' },
  alternativas:     { title: 'Alternativas IA',      what: 'Comparar estrategias de cobertura' },
  proposeAbsence:   { title: 'Plan de ausencia',     what: 'Cobertura día a día durante el rango' }
};

function formatDate(year, month, day) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(day + 1)}/${pad(month + 1)}/${year}`;
}

function buildSummary(action, worker, p, override = {}) {
  const lbl = ACTION_LABELS[action] || { title: action, what: '' };
  const where = (PLANT_NAMES[worker?.planta] || worker?.planta || '?') +
                (worker?.role ? ` · ${worker.role}` : '');
  return {
    action,
    title: override.title || lbl.title,
    who: worker?.name || '?',
    workerId: worker?.id,
    actaisId: worker?.actaisId,
    when: formatDate(p.year, p.month, p.day),
    what: override.what || lbl.what,
    where: override.where || where
  };
}

// ============================================================================
// buildCoverPlan — genera DOS opciones de cobertura cuando hay que sustituir:
//   primary    = mayor score (misma planta > flotante; turno preferido; menos
//                noches este mes)
//   alternative = mismo pool pero re-rankeado por balance (penaliza al worker
//                que ya lleva muchos turnos este mes)
// Filtra estrictamente por rol (DUE→DUE, tec→tec, micro→micro) y por planta
// (o flotantes) y pasa cada candidato por el motor de legalidad completo.
// ============================================================================
function chainContext(data, workerId, p) {
  // Devuelve el turno del día anterior y el siguiente (con cross-month).
  // Sirve para mostrar a la supervisora qué le espera al candidato antes y
  // después — info que ayuda a decidir aunque las reglas ya estén OK.
  const sd = data?.scheduleData || {};
  const previous = engine.cellOf(sd, p.year, p.month, workerId, p.day - 1)
                || engine.getCrossMonthShift(sd, workerId, p.year, p.month, p.day === 0 ? -1 : 0);
  const sch = sd?.[`${p.year}-${p.month}`]?.[workerId] || [];
  const lastIdx = sch.length - 1;
  const next = engine.cellOf(sd, p.year, p.month, workerId, p.day + 1)
            || (p.day === lastIdx ? engine.getCrossMonthShift(sd, workerId, p.year, p.month, +1) : '');
  return { previous: previous || '', next: next || '' };
}

function buildCoverPlan(data, absentWorker, p, targetShift) {
  if (!absentWorker || !targetShift) return null;
  const workers = data.workerMeta || data.workers || [];
  const targetRole = engine.roleOf(absentWorker);
  const targetPlanta = absentWorker.planta;
  const monthSch = data?.scheduleData?.[p.year + '-' + p.month] || {};

  const scored = workers
    .filter(w => String(w.id) !== String(absentWorker.id))
    .filter(w => !targetRole || engine.roleOf(w) === targetRole)
    .filter(w => w.planta === targetPlanta || w.flotante)
    .map(w => {
      const ev = engine.evaluateAssignment(w.id, p.day, targetShift, data.scheduleData || {}, workers, p.year, p.month);
      if (!ev.legal) return null;
      const scoring = scoreCandidate(data, w, p.year, p.month, p.day, targetShift, targetPlanta);
      const myMonth = monthSch[w.id] || [];
      const workedDays = myMonth.filter(s => SHIFT_CODES.includes(s)).length;
      const nightsDone = myMonth.filter(s => s === 'N').length;
      // Estrategia balance: penaliza al que ya ha currado mucho
      const balancePenalty = Math.max(0, workedDays - 15) * 3;
      const chain = chainContext(data, w.id, p);
      return {
        workerId: w.id,
        name: w.name,
        planta: w.planta,
        plantaLabel: PLANT_NAMES[w.planta] || w.planta,
        role: w.role,
        flotante: !!w.flotante,
        crossPlant: w.planta !== targetPlanta,
        score: scoring.score,
        scoreBalance: scoring.score - balancePenalty,
        breakdown: scoring.breakdown,
        workedDays,
        nightsDone,
        previousShift: chain.previous,
        nextShift: chain.next,
        legalChecks: ev.checks
      };
    })
    .filter(Boolean);

  if (scored.length === 0) {
    return { primary: null, alternative: null, all: [], moreCount: 0 };
  }

  const byScore   = [...scored].sort((a, b) => b.score - a.score);
  const byBalance = [...scored].sort((a, b) => b.scoreBalance - a.scoreBalance);

  const primaryC = byScore[0];
  let altC = byBalance.find(c => c.workerId !== primaryC.workerId);
  if (!altC && byScore.length > 1) altC = byScore[1];

  return {
    primary:     primaryC ? { label: 'Mejor opción',          strategy: 'score',   candidate: primaryC } : null,
    alternative: altC     ? { label: 'Mejor balance de carga', strategy: 'balance', candidate: altC     } : null,
    all: byScore.slice(0, 5),
    moreCount: Math.max(0, scored.length - 2)
  };
}

// Convierte checks[] del engine en `verdict` global + verdictLabel
function summarizeVerdict(checks, opts = {}) {
  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warning').length;
  const verdict = failed > 0 ? 'blocked' : warned > 0 ? 'warning' : 'ok';
  const verdictLabel = opts.labels?.[verdict] || (
    verdict === 'blocked' ? 'No legal'
    : verdict === 'warning' ? 'Atención'
    : 'Cumple'
  );
  return { verdict, verdictLabel, failed, warned };
}

// ===== Scoring básico (reutiliza concepto de scoreCandidate del cliente) =====
function scoreCandidate(data, worker, year, month, day, shift, targetPlanta) {
  let score = 0;
  const breakdown = [];

  if (worker.planta === targetPlanta) { score += 30; breakdown.push('Misma planta +30'); }
  else if (worker.flotante) { score += 20; breakdown.push('Flotante +20'); }
  else { score += 5; breakdown.push('Otra planta +5'); }

  const monthSchedule = data?.scheduleData?.[ymKey(year, month)]?.[worker.id] || [];
  const workedDays = monthSchedule.filter(s => SHIFT_CODES.includes(s)).length;
  const fatigue = Math.max(0, 30 - workedDays);
  score += fatigue; breakdown.push(`Carga del mes (descanso) +${fatigue}`);

  if (worker.rules?.preferredShift === shift) { score += 15; breakdown.push('Turno preferido +15'); }
  if (worker.rules?.conciliacion && shift === 'N') { score -= 20; breakdown.push('Conciliación familiar (noche) −20'); }

  const nightCount = monthSchedule.filter(s => s === 'N').length;
  if (shift === 'N') { score -= nightCount * 8; breakdown.push(`Noches ya hechas: −${nightCount * 8}`); }

  return { score: Math.max(0, Math.round(score)), breakdown };
}

// ===== detectFragilePlantas reducido =====
function detectFragilePlantas(data, todayY, todayM, todayD, daysAhead = 7) {
  const result = {};
  for (let offset = 0; offset < daysAhead; offset++) {
    const date = new Date(todayY, todayM, todayD + offset);
    const y = date.getFullYear();
    const m = date.getMonth();
    const d = date.getDate() - 1;
    const monthSchedules = data?.scheduleData?.[ymKey(y, m)] || {};

    for (const plantaId of Object.keys(PLANT_COVERAGE)) {
      if (plantaId === 'refuerzo') continue;
      for (const shift of SHIFT_CODES) {
        const required = PLANT_COVERAGE[plantaId][shift] || 0;
        if (required === 0) continue;
        let assigned = 0;
        for (const wId of Object.keys(monthSchedules)) {
          const cellShift = monthSchedules[wId][d];
          if (cellShift !== shift) continue;
          const effective = getEffectivePlanta(data, wId, y, m, d);
          if (effective === plantaId) assigned++;
        }
        const deficit = required - assigned;
        if (deficit > 0) {
          if (!result[plantaId]) result[plantaId] = { plantaId, name: PLANT_NAMES[plantaId], score: 0, gaps: [] };
          result[plantaId].score += deficit * 10 + (shift === 'N' ? 20 : 0);
          result[plantaId].gaps.push({ date: date.toISOString().slice(0, 10), shift, deficit });
        }
      }
    }
  }
  return Object.values(result).sort((a, b) => b.score - a.score);
}

// ===== Plantillas Secretario =====
function tplWhatsApp(worker, dateISO, shift, plantaId, requester) {
  const plantName = PLANT_NAMES[plantaId] || plantaId;
  const shiftName = { M: 'mañana', T: 'tarde', N: 'noche' }[shift] || shift;
  return `Hola ${worker?.name || ''}, ¿podrías cubrir el turno de ${shiftName} del ${dateISO} en ${plantName}? Gracias.
— ${requester || 'Supervisión'}`;
}

function tplReplacementRequest(workerOut, workerIn, dateISO, shift) {
  const shiftName = { M: 'Mañana', T: 'Tarde', N: 'Noche' }[shift] || shift;
  return `Solicitud de cambio de turno

Trabajador que se ausenta: ${workerOut?.name || '—'}
Trabajador que cubre: ${workerIn?.name || '—'}
Fecha: ${dateISO}
Turno: ${shiftName}

Motivo: [completar]
Validación de convenio: pendiente de revisión.`;
}

// ===== Helpers de routing =====
function parseCell(body) {
  const cell = body?.cell || {};
  const ctx = body?.context || {};
  // Acepta nombres en varios alias para no perder el dato según el cliente:
  //  - cell.worker            (legacy: detector.js Alt+click)
  //  - cell.workerName        (nuevo: panel + editor de reglas)
  //  - context.workerName     (broadcast del detector)
  // Fecha: cell.dayISO (panel YYYY-MM-DD) tiene preferencia sobre {year,month,day}
  // numéricos del detector.
  let year  = Number.isFinite(cell.year)  ? cell.year  : new Date().getFullYear();
  let month = Number.isFinite(cell.month) ? cell.month : new Date().getMonth();
  let day   = Number.isFinite(cell.day)   ? cell.day   : new Date().getDate() - 1;
  if (typeof cell.dayISO === 'string') {
    const m = cell.dayISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      year = parseInt(m[1], 10);
      month = parseInt(m[2], 10) - 1;
      day = parseInt(m[3], 10) - 1;
    }
  }
  return {
    year, month, day,
    shift: cell.shift || null,
    workerId: cell.workerId ?? cell.workerHint ?? ctx.workerId ?? null,
    workerName: cell.workerName || cell.worker || ctx.workerName || ctx.worker || null,
    plantaId: cell.plantaId || ctx.plantaId || null
  };
}

async function loadData(pool, userId) {
  const result = await pool.query('SELECT data FROM schedule_data WHERE user_id = $1', [userId]);
  const data = result.rows[0]?.data || {};
  // Auto-persist de bindings de actaisId que se marcaron durante este request.
  // Se ejecuta DESPUÉS de que el handler responda, porque setTimeout 500ms
  // garantiza que resolveWorker ya tuvo tiempo de marcar __bindActaisId.
  // 'data' se mantiene en memoria por reference mientras el timeout está vivo.
  setTimeout(() => persistBindings(pool, userId, data).catch(e => console.warn('[bind]', e.message)), 500);
  return data;
}

function resolveWorker(data, parsed) {
  const all = data?.workerMeta || data?.workers || [];
  // 1. Match directo por workerId interno O actaisId ya vinculado
  if (parsed.workerId) {
    const direct = workerById(data, parsed.workerId);
    if (direct) return direct;
  }
  // 2. Match por nombre exacto / contains
  if (parsed.workerName) {
    const norm = parsed.workerName.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const exact = all.find(w => {
      const wn = (w.name || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return norm === wn || norm.includes(wn) || wn.includes(norm);
    });
    if (exact) {
      if (parsed.workerId && !exact.actaisId) exact.__bindActaisId = parsed.workerId;
      return exact;
    }
    // 3. Fuzzy V2: Levenshtein + Jaro-Winkler (importado de engine/name-matcher)
    const m = matchWorker(parsed.workerName, all);
    if (m.match) {
      if (parsed.workerId && !m.match.actaisId) m.match.__bindActaisId = parsed.workerId;
      return m.match;
    }
  }
  return null;
}

async function persistBindings(pool, userId, data) {
  const all = data?.workerMeta || data?.workers || [];
  const newlyBound = all.filter(w => w.__bindActaisId);
  if (newlyBound.length === 0) return false;
  for (const w of newlyBound) {
    w.actaisId = w.__bindActaisId;
    delete w.__bindActaisId;
  }
  try {
    await pool.query(
      `INSERT INTO schedule_data (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = $2`,
      [userId, data]
    );
    return true;
  } catch (err) {
    console.error('[persistBindings]', err);
    return false;
  }
}

// ============================================================================
// Router
// ============================================================================
function buildAssistantRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(express.json({ limit: '50kb' }));
  router.use(authMiddleware);

  router.post('/canChange', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      if (!worker) return res.json({ ok: false, reasons: ['No se pudo identificar al trabajador'] });
      const targetShift = p.shift || 'M';
      const result = checkLegality(data, worker, p.year, p.month, p.day, targetShift);
      res.json({ ok: result.legal, reasons: result.reasons, worker: worker.name, date: { year: p.year, month: p.month, day: p.day }, shift: targetShift });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.canChange]', err); }
  });

  router.post('/validateConvenio', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      if (!worker) {
        return res.json({
          ok: false, legal: false, verdict: 'blocked',
          verdictLabel: 'Trabajador no identificado',
          error: workerNotFoundError(p, data),
          summary: buildSummary('validateConvenio', null, p, { where: '?' })
        });
      }
      const targetShift = p.shift || cellOf(data, p.year, p.month, worker.id, p.day) || 'M';
      const ev = evaluateFull(data, worker, p.year, p.month, p.day, targetShift);
      const v = summarizeVerdict(ev.checks, {
        labels: { blocked: 'No cumple', warning: 'Atención', ok: 'Cumple todas las reglas' }
      });
      res.json({
        ok: ev.legal, legal: ev.legal,
        verdict: v.verdict, verdictLabel: v.verdictLabel,
        worker: worker.name,
        summary: buildSummary('validateConvenio', worker, p, { what: `Asignar turno ${targetShift}` }),
        reasoning: ev.checks,
        // back-compat
        reasons: ev.legal ? ['Cumple todas las reglas'] : ev.reasons,
        date: { year: p.year, month: p.month, day: p.day },
        shift: targetShift
      });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.validateConvenio]', err); }
  });

  router.post('/whoCovers', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const absentWorker = resolveWorker(data, p);
      if (!absentWorker) {
        return res.json({
          ok: false, verdict: 'blocked', verdictLabel: 'Trabajador no identificado',
          error: workerNotFoundError(p, data),
          summary: buildSummary('whoCovers', null, p, { where: '?' })
        });
      }
      const targetPlanta = p.plantaId || absentWorker.planta;
      const targetShift = p.shift || cellOf(data, p.year, p.month, absentWorker.id, p.day) || 'M';
      const targetRole = engine.roleOf(absentWorker);
      const workers = data.workerMeta || data.workers || [];

      // Solo candidatos del MISMO ROL — un técnico no sustituye a una DUE.
      // Si no encontramos role, abrimos a todos (defensiva).
      const candidates = workers
        .filter(w => String(w.id) !== String(absentWorker.id))
        .filter(w => !targetRole || engine.roleOf(w) === targetRole)
        .map(w => {
          const ev = engine.evaluateAssignment(w.id, p.day, targetShift, data.scheduleData || {}, workers, p.year, p.month);
          if (!ev.legal) return null;
          const scoring = scoreCandidate(data, w, p.year, p.month, p.day, targetShift, targetPlanta);
          return {
            workerId: w.id, name: w.name, planta: w.planta, role: w.role, flotante: !!w.flotante,
            crossPlant: w.planta !== targetPlanta,
            score: scoring.score, breakdown: scoring.breakdown
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      const verdict = candidates.length === 0 ? 'blocked' : 'ok';
      const roleLabel = targetRole === 'enf' ? 'DUE' : targetRole === 'tec' ? 'Técnico' : targetRole === 'micro' ? 'Microbiología' : '(rol)';

      const coverPlan = buildCoverPlan(data, absentWorker, p, targetShift);

      res.json({
        ok: true,
        verdict,
        verdictLabel: candidates.length === 0
          ? `Sin candidatos ${roleLabel} para cubrir ${targetShift}`
          : `${candidates.length} candidato(s) ${roleLabel}`,
        summary: buildSummary('whoCovers', absentWorker, p, { what: `Buscar sustituto ${roleLabel} para turno ${targetShift}` }),
        reasoning: [
          { rule: 'Búsqueda por rol', status: 'pass', detail: `Solo ${roleLabel}s en planta ${PLANT_NAMES[targetPlanta] || targetPlanta} o flotantes` },
          { rule: 'Legalidad de cada candidato', status: 'pass', detail: 'Cada uno pasó las 7 reglas del motor (cross-month, whitelist post-noche, máx noches, etc.)' },
          { rule: 'Dos estrategias', status: 'pass', detail: 'Primary = mejor score · Alternative = mejor balance de carga' }
        ],
        coverPlan,
        targetPlanta, targetShift, candidates
      });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.whoCovers]', err); }
  });

  router.post('/suggestReplacement', async (req, res) => {
    // Alias semantico de whoCovers — extraido como funcion para evitar
    // depender de router.handle (que requiere next y rompe el contrato Express).
    req.url = '/whoCovers';
    return router.handle(req, res, () => {});
  });

  router.post('/librar', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      if (!worker) {
        return res.json({
          ok: false,
          verdict: 'blocked',
          verdictLabel: 'Trabajador no identificado',
          error: workerNotFoundError(p, data),
          summary: buildSummary('librar', null, p, { where: '?' })
        });
      }

      const originalShift = cellOf(data, p.year, p.month, worker.id, p.day);
      const targetPlanta = worker.planta;
      const targetPlantaLabel = PLANT_NAMES[targetPlanta] || targetPlanta || '?';
      const monthSchedules = data?.scheduleData?.[p.year + '-' + p.month] || {};
      const workers = data.workerMeta || data.workers || [];
      const myRole = engine.roleOf(worker);
      const isWE = engine.isWeekendOrHoliday(p.year, p.month, p.day);

      // Cobertura ACTUAL del turno en esa planta, FILTRANDO POR ROL.
      // Un técnico no cuenta como cobertura de una DUE y viceversa — el web
      // engine aplica cobertura por (rol, día, turno), no por planta plana.
      let coveringNow = 0;
      const otherCoverers = [];
      for (const wId of Object.keys(monthSchedules)) {
        const arr = monthSchedules[wId] || [];
        if (arr[p.day] !== originalShift) continue;
        const w2 = workerById(data, wId);
        if (!w2) continue;
        if (w2.planta !== targetPlanta) continue;
        if (myRole && engine.roleOf(w2) !== myRole) continue;
        coveringNow++;
        if (String(wId) !== String(worker.id)) otherCoverers.push(w2.name);
      }
      const required = engine.getRequiredForShift(targetPlanta, myRole, originalShift, p.year, p.month, p.day);
      const afterIfRemoved = coveringNow - 1;
      const wouldGenerateGap = afterIfRemoved < required;
      const atBareMinimum = afterIfRemoved === required && required > 0;

      // Sustitutos POTENCIALES: workers del MISMO ROL en la planta o flotantes
      // que ese día estén en D/L/LD/vacío y pasen el motor de legalidad.
      let potentialSubstitutes = 0;
      const substituteNames = [];
      for (const w of workers) {
        if (String(w.id) === String(worker.id)) continue;
        if (myRole && engine.roleOf(w) !== myRole) continue;
        if (w.planta !== targetPlanta && !w.flotante) continue;
        const cell = (monthSchedules[w.id] || [])[p.day] || '';
        if (!['', 'D', 'L', 'LD'].includes(String(cell).trim())) continue;
        const ev = engine.isLegalAssignment(w.id, p.day, originalShift, data.scheduleData || {}, workers, p.year, p.month);
        if (ev.legal) { potentialSubstitutes++; substituteNames.push(w.name); }
      }

      // Razonamiento — qué reglas miramos para esta acción
      const reasoning = [];

      // 1. Estado actual del día
      if (engine.UNAVAILABLE_CODES.includes(originalShift)) {
        reasoning.push({ rule: 'Estado del día', status: 'fail', detail: `Ya está en ${originalShift} (ausencia). No hay nada que librar.` });
      } else if (!originalShift || originalShift === 'D') {
        reasoning.push({ rule: 'Estado del día', status: 'warning', detail: 'El día ya está en descanso o vacío.' });
      } else {
        reasoning.push({ rule: 'Estado del día', status: 'pass', detail: `Día asignado a turno ${originalShift}` });
      }

      // 2. Cobertura — usa la misma tabla que la web (RULES.COVERAGE), por
      //    rol (enf/tec/micro) y día (semana/fin-de-semana).
      const dayKind = isWE ? 'fin de semana/festivo' : 'entre semana';
      const roleLabel = myRole === 'enf' ? 'DUE' : myRole === 'tec' ? 'Técnico' : myRole === 'micro' ? 'Microbiología' : '(rol no detectado)';
      if (required === 0) {
        reasoning.push({ rule: 'Cobertura mínima', status: 'pass', detail: `${roleLabel} no requiere cobertura para ${originalShift} ${dayKind} en ${targetPlantaLabel}` });
      } else if (wouldGenerateGap) {
        reasoning.push({ rule: 'Cobertura mínima', status: 'fail', detail: `Quedarían ${afterIfRemoved} ${roleLabel}(s) en ${originalShift}, mínimo requerido ${required} (${dayKind})` });
      } else if (atBareMinimum) {
        reasoning.push({ rule: 'Cobertura mínima', status: 'warning', detail: `Quedarían justo ${afterIfRemoved} ${roleLabel}(s) (= mínimo ${required}). Sin margen.` });
      } else {
        reasoning.push({ rule: 'Cobertura mínima', status: 'pass', detail: `${coveringNow} ${roleLabel}(s) ahora → ${afterIfRemoved} tras librar · mínimo ${required} (${dayKind})` });
      }

      // 3. Sustitutos disponibles — workers del mismo rol que pasan checkLegality
      if (potentialSubstitutes === 0 && wouldGenerateGap) {
        reasoning.push({ rule: 'Sustitutos disponibles', status: 'fail', detail: `Ningún ${roleLabel} libre legalmente para cubrir ${originalShift}` });
      } else if (potentialSubstitutes === 0) {
        reasoning.push({ rule: 'Sustitutos disponibles', status: 'warning', detail: `Ningún ${roleLabel} libre, pero hay margen de cobertura` });
      } else {
        const namesList = substituteNames.slice(0, 4).join(', ') + (substituteNames.length > 4 ? `, +${substituteNames.length - 4} más` : '');
        reasoning.push({ rule: 'Sustitutos disponibles', status: 'pass', detail: `${potentialSubstitutes} ${roleLabel}(s) elegibles: ${namesList}` });
      }

      // 4. Otros cubriendo (informativo)
      if (otherCoverers.length > 0) {
        reasoning.push({ rule: 'Otros en el mismo turno', status: 'pass', detail: otherCoverers.slice(0, 4).join(', ') + (otherCoverers.length > 4 ? `, +${otherCoverers.length - 4} más` : '') });
      }

      const v = summarizeVerdict(reasoning, {
        labels: {
          blocked: 'No se puede librar',
          warning: 'Cuidado: hueco al límite',
          ok: 'Se puede librar sin problema'
        }
      });

      // Plan de cobertura: SIEMPRE incluido, da igual el veredicto, porque
      // la supervisora quiere ver opciones antes de decidir.
      const coverPlan = buildCoverPlan(data, worker, p, originalShift);

      res.json({
        ok: true,
        verdict: v.verdict,
        verdictLabel: v.verdictLabel,
        worker: worker.name,
        summary: buildSummary('librar', worker, p, { what: `Convertir turno ${originalShift || '∅'} → descanso` }),
        reasoning,
        coverPlan,
        // payload legacy (back-compat con el frontend viejo)
        originalShift,
        plantaAffected: targetPlantaLabel,
        currentCoverage: coveringNow,
        requiredCoverage: required,
        wouldGenerateGap,
        potentialSubstitutes,
        suggestion: v.verdict === 'blocked'
          ? 'No se puede librar este día (revisa razonamiento).'
          : v.verdict === 'warning'
            ? 'Se puede librar pero quedará en el mínimo. Considera asignar sustituto antes.'
            : 'Se puede librar sin generar hueco.'
      });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.librar]', err); }
  });

  // Helper: mensaje rico cuando resolveWorker devuelve null. Da pistas al
  // supervisor sobre por qué no encuentra al trabajador.
  function workerNotFoundError(p, data) {
    const total = (data?.workerMeta || data?.workers || []).length;
    const name = p.workerName;
    const id = p.workerId;
    if (total === 0) return 'No tienes planillas importadas todavía. Sube los PDFs en el tab Importar.';
    if (name && id) return `No encuentro a "${name}" (Actais id ${id}) entre los ${total} trabajadores importados. ¿Subiste su PDF? Si tiene Mª/abreviaturas, puede que el nombre del PDF no coincida exactamente.`;
    if (name) return `No encuentro a "${name}" entre los ${total} trabajadores importados.`;
    if (id) return `No encuentro Actais id ${id} entre los ${total} trabajadores. Hace falta que hagas Alt+click después de seleccionar al empleado en el árbol.`;
    return `No se pudo identificar (sin nombre ni id en el contexto). Selecciona un empleado en el árbol antes de la acción.`;
  }

  router.post('/vacaciones', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const days = Array.isArray(req.body?.days) ? req.body.days : [p.day];
      const worker = resolveWorker(data, p);
      if (!worker) return res.json({ ok: false, error: 'Trabajador no identificado' });
      const impacted = [];
      for (const d of days) {
        const shift = cellOf(data, p.year, p.month, worker.id, d);
        if (!SHIFT_CODES.includes(shift)) continue;
        impacted.push({ day: d, shift });
      }
      res.json({ ok: true, worker: worker.name, daysCount: days.length, workShiftsAffected: impacted, note: 'Pendiente sugerir sustitutos día a día — usa "¿Quién cubre?" en cada uno.' });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.vacaciones]', err); }
  });

  router.post('/cambio', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      if (!worker) return res.json({ ok: false, error: 'Trabajador no identificado' });
      const monthSchedules = data?.scheduleData?.[ymKey(p.year, p.month)] || {};
      const targetShift = p.shift || cellOf(data, p.year, p.month, worker.id, p.day);
      const swapPartners = (data?.workerMeta || data?.workers || [])
        .filter(w => w.id !== worker.id)
        .map(w => {
          const arr = monthSchedules[w.id] || [];
          const otherShift = arr[p.day];
          if (!otherShift || !SHIFT_CODES.includes(otherShift) || otherShift === targetShift) return null;
          const legA = checkLegality(data, worker, p.year, p.month, p.day, otherShift);
          const legB = checkLegality(data, w, p.year, p.month, p.day, targetShift);
          if (!legA.legal || !legB.legal) return null;
          return { partner: w.name, partnerId: w.id, currentShift: otherShift };
        })
        .filter(Boolean)
        .slice(0, 5);
      res.json({ targetShift, candidates: swapPartners });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.cambio]', err); }
  });

  // ============================================================================
  // /alternativas — TRES estrategias contrastadas (en lugar de 2 anteriores).
  // Cada plan rankea a los mismos candidatos legales con un objetivo distinto:
  //
  //   planA "Mejor ajuste"         → pure score (misma planta > turno preferido > pocas noches)
  //   planB "Balance carga"        → penaliza al que ya tiene > 15 días trabajados este mes
  //   planC "Reparto noches"       → penaliza al que ya tiene muchas noches este mes
  //
  // Devuelve top-3 por estrategia + un análisis comparativo (overlap entre
  // planes, recomendación textual, riesgos).
  // ============================================================================
  router.post('/alternativas', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      if (!worker) {
        return res.json({
          ok: false, verdict: 'blocked', verdictLabel: 'Trabajador no identificado',
          error: workerNotFoundError(p, data),
          summary: buildSummary('alternativas', null, p, { where: '?' })
        });
      }
      const targetShift = p.shift || cellOf(data, p.year, p.month, worker.id, p.day) || 'M';
      const targetPlanta = p.plantaId || worker.planta;
      const targetRole = engine.roleOf(worker);
      const workers = data.workerMeta || data.workers || [];
      const monthSch = data?.scheduleData?.[p.year + '-' + p.month] || {};

      const pool_ = workers
        .filter(w => String(w.id) !== String(worker.id))
        .filter(w => !targetRole || engine.roleOf(w) === targetRole)
        .filter(w => w.planta === targetPlanta || w.flotante)
        .map(w => {
          const ev = engine.evaluateAssignment(w.id, p.day, targetShift, data.scheduleData || {}, workers, p.year, p.month);
          if (!ev.legal) return null;
          const scoring = scoreCandidate(data, w, p.year, p.month, p.day, targetShift, targetPlanta);
          const sch = monthSch[w.id] || [];
          const workedDays = sch.filter(s => SHIFT_CODES.includes(s)).length;
          const nightsDone = sch.filter(s => s === 'N').length;
          return {
            workerId: w.id, name: w.name, planta: w.planta, plantaLabel: PLANT_NAMES[w.planta] || w.planta, role: w.role, flotante: !!w.flotante,
            crossPlant: w.planta !== targetPlanta,
            score: scoring.score,
            breakdown: scoring.breakdown,
            workedDays, nightsDone
          };
        })
        .filter(Boolean);

      function pick(strategy) {
        const ranked = pool_.map(c => {
          let s = c.score;
          if (strategy === 'balance') s -= Math.max(0, c.workedDays - 15) * 3;
          if (strategy === 'nights')  s -= c.nightsDone * 4;
          return { ...c, finalScore: s };
        }).sort((a, b) => b.finalScore - a.finalScore).slice(0, 3);
        return ranked;
      }
      const planA = pick('score');
      const planB = pick('balance');
      const planC = pick('nights');

      // Análisis comparativo
      const topByPlan = { A: planA[0]?.workerId, B: planB[0]?.workerId, C: planC[0]?.workerId };
      const allSame = topByPlan.A && topByPlan.A === topByPlan.B && topByPlan.B === topByPlan.C;
      const recommendation = allSame
        ? `Las tres estrategias coinciden en ${planA[0].name}. Es la elección clara.`
        : `Estrategias distintas → considera el contexto: si quieres balance de carga elige Plan B, si quieres repartir noches elige Plan C.`;

      const reasoning = [
        { rule: 'Plan A — Mejor ajuste', status: 'pass', detail: planA[0] ? `${planA[0].name} (score ${planA[0].finalScore})` : 'sin candidatos' },
        { rule: 'Plan B — Balance carga', status: 'pass', detail: planB[0] ? `${planB[0].name} (score ${planB[0].finalScore}, ya ${planB[0].workedDays} días)` : 'sin candidatos' },
        { rule: 'Plan C — Reparto noches', status: 'pass', detail: planC[0] ? `${planC[0].name} (score ${planC[0].finalScore}, ya ${planC[0].nightsDone} noches)` : 'sin candidatos' },
        { rule: 'Convergencia', status: allSame ? 'pass' : 'warning', detail: allSame ? 'Las 3 estrategias coinciden — alta confianza' : 'Estrategias divergen — decide según prioridad' }
      ];

      res.json({
        ok: true,
        verdict: pool_.length === 0 ? 'blocked' : 'ok',
        verdictLabel: pool_.length === 0 ? `Sin candidatos para cubrir ${targetShift}` : `${pool_.length} candidatos analizados con 3 estrategias`,
        worker: worker.name,
        summary: buildSummary('alternativas', worker, p, { what: `3 estrategias para cubrir ${targetShift}` }),
        reasoning,
        plans: {
          A: { label: 'Mejor ajuste',    strategy: 'score',   candidates: planA },
          B: { label: 'Balance carga',   strategy: 'balance', candidates: planB },
          C: { label: 'Reparto noches',  strategy: 'nights',  candidates: planC }
        },
        recommendation,
        targetShift, targetPlanta
      });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.alternativas]', err); }
  });

  // ============================================================================
  // Editor de reglas subjetivas por trabajador.
  // POST /worker/getRules  body: { workerId }
  // POST /worker/setRules  body: { workerId, rules: {...} }
  // ============================================================================
  router.post('/worker/getRules', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      if (!worker) {
        return res.json({ ok: false, error: workerNotFoundError(p, data) });
      }
      res.json({
        ok: true,
        worker: { id: worker.id, name: worker.name, planta: worker.planta, role: worker.role },
        rules: worker.rules || {}
      });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.worker.getRules]', err); }
  });

  router.post('/worker/setRules', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      if (!worker) return res.json({ ok: false, error: workerNotFoundError(p, data) });

      // sw.js empaqueta args como req.body.cell, fallback a body raíz para curl directo
      const incoming = req.body?.cell?.rules || req.body?.rules || {};
      // Whitelist de claves admitidas — evita inyectar campos arbitrarios.
      const allowed = ['noNights', 'noSwap', 'noCover', 'onlyMornings', 'noWeekends', 'maxNightsPerMonth', 'preferredShift', 'conciliacion'];
      worker.rules = worker.rules || {};
      const changed = {};
      for (const k of allowed) {
        if (k in incoming) {
          const v = incoming[k];
          // Limpiar valores nulos/false que no tengan sentido
          if (v === null || v === '' || v === false || v === undefined) {
            if (k in worker.rules) { delete worker.rules[k]; changed[k] = null; }
          } else {
            worker.rules[k] = v; changed[k] = v;
          }
        }
      }

      await pool.query(
        `INSERT INTO schedule_data (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = $2`,
        [req.user.id, data]
      );
      res.json({
        ok: true,
        worker: { id: worker.id, name: worker.name },
        rules: worker.rules,
        changed,
        message: `Reglas actualizadas para ${worker.name}`
      });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.worker.setRules]', err); }
  });

  router.post('/fragilePlantas', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const now = new Date();
      const daysAhead = Number.isFinite(req.body?.daysAhead) ? req.body.daysAhead : 7;
      const fragile = detectFragilePlantas(data, now.getFullYear(), now.getMonth(), now.getDate(), daysAhead);
      res.json({ daysAhead, fragile });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.fragilePlantas]', err); }
  });

  router.post('/draftWhatsApp', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      // p.day llega 0-based (detector ya envia day-1). El constructor Date()
      // tambien usa day 1-based en su tercer argumento, asi que sumamos +1.
      const dateISO = new Date(p.year, p.month, p.day + 1).toISOString().slice(0, 10);
      const text = tplWhatsApp(worker, dateISO, p.shift || 'M', p.plantaId || worker?.planta, req.user?.name);
      res.json({ text });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.draftWhatsApp]', err); }
  });

  router.post('/draftReplacementRequest', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const workerOut = resolveWorker(data, p);
      const workerIn = req.body?.replacementId ? workerById(data, req.body.replacementId) : null;
      const dateISO = new Date(p.year, p.month, p.day + 1).toISOString().slice(0, 10);
      res.json({ text: tplReplacementRequest(workerOut, workerIn, dateISO, p.shift || 'M') });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.draftReplacementRequest]', err); }
  });

  router.post('/weeklySummary', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const now = new Date();
      const fragile = detectFragilePlantas(data, now.getFullYear(), now.getMonth(), now.getDate(), 7);
      const totalDeficit = fragile.reduce((sum, p) => sum + p.gaps.reduce((s, g) => s + g.deficit, 0), 0);
      res.json({
        weekStarts: now.toISOString().slice(0, 10),
        plantsAtRisk: fragile.length,
        totalGaps: totalDeficit,
        topRisks: fragile.slice(0, 3).map(f => ({ name: f.name, score: f.score, gapsCount: f.gaps.length }))
      });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.weeklySummary]', err); }
  });

  // Volcar cambio que la super ha hecho directamente en Actais (sin pasar
  // por el menú IA). El detector relee la celda y manda { workerId, year,
  // month, day, shift, shiftLabel }. Aquí escribimos en scheduleData del
  // user. No tocamos Actais (es lectura privada).
  router.post('/syncCellChange', async (req, res) => {
    try {
      const p = parseCell(req.body);
      if (!p.shift) return res.status(400).json({ ok: false, error: 'Falta shift' });

      // Cargar y resolver worker
      const dataResult = await pool.query('SELECT data FROM schedule_data WHERE user_id = $1', [req.user.id]);
      const data = dataResult.rows[0]?.data || { workerMeta: [], scheduleData: {} };
      if (!data.workerMeta) data.workerMeta = [];
      if (!data.scheduleData) data.scheduleData = {};

      const worker = resolveWorker(data, p);
      if (!worker) {
        return res.json({ ok: false, error: 'Trabajador no identificado en Shiftia. Importa primero su planilla.' });
      }

      const key = ymKey(p.year, p.month);
      if (!data.scheduleData[key]) data.scheduleData[key] = {};
      if (!data.scheduleData[key][worker.id]) data.scheduleData[key][worker.id] = new Array(31).fill('');

      const arr = data.scheduleData[key][worker.id];
      const prev = arr[p.day] || '';
      arr[p.day] = p.shift;

      await pool.query(
        `INSERT INTO schedule_data (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = $2`,
        [req.user.id, data]
      );

      res.json({
        ok: true,
        worker: worker.name,
        date: { year: p.year, month: p.month, day: p.day },
        previousShift: prev,
        newShift: p.shift,
        message: prev === p.shift
          ? 'Sin cambios: el turno ya era ' + p.shift
          : `Volcado: ${prev || 'vacío'} → ${p.shift}`
      });
    } catch (err) {
      console.error('[assistant.syncCellChange]', err);
      res.status(500).json({ error: 'Error interno al volcar el cambio' });
    }
  });

  // ============================================================================
  // /syncWorkerMonth — volcado de un mes entero leído del DOM de Actais.
  // Body: { workerId | workerName, year, month (0-based), cells: [31 strings] }
  //
  // Compara cell-by-cell con lo que tiene el backend y registra qué cambió.
  // Útil tras un cambio manual en Actais — la supervisora pulsa "refrescar y
  // volcar" en el panel y el motor IA queda sincronizado al instante.
  // ============================================================================
  router.post('/syncWorkerMonth', async (req, res) => {
    try {
      const p = parseCell(req.body);
      const data = await loadData(pool, req.user.id);
      if (!data.workerMeta) data.workerMeta = [];
      let worker = resolveWorker(data, p);

      // AUTO-CREACIÓN: si el trabajador no existe en Shiftia pero la extensión
      // manda nombre oficial (del árbol de Actais) + actaisId, lo creamos al
      // vuelo en lugar de exigir importar el PDF primero. En dryRun solo se
      // anuncia (willCreate), sin tocar nada.
      let toCreate = null;
      if (!worker && p.workerName && p.workerId) {
        const nextId = data.workerMeta.reduce((m, w) => Math.max(m, parseInt(w.id, 10) || 0), 0) + 1;
        toCreate = {
          id: nextId,
          name: p.workerName,
          actaisId: String(p.workerId),
          role: 'enf',
          planta: null,
          flotante: false,
          modalidad: 'fijo',
          rules: {},
          createdFromActais: true
        };
        worker = toCreate;
      }
      if (!worker) {
        return res.json({ ok: false, error: workerNotFoundError(p, data) });
      }
      const cells = Array.isArray(req.body?.cell?.cells) ? req.body.cell.cells
                  : Array.isArray(req.body?.cells)        ? req.body.cells
                  : null;
      if (!cells) return res.json({ ok: false, error: 'Faltan cells[]' });
      const year  = Number.isFinite(req.body?.cell?.year)  ? req.body.cell.year  : p.year;
      const month = Number.isFinite(req.body?.cell?.month) ? req.body.cell.month : p.month;

      if (!data.scheduleData) data.scheduleData = {};
      const key = `${year}-${month}`;
      const prev = data.scheduleData[key]?.[worker.id] || new Array(31).fill('');

      // Diff celda a celda (función pura compartida — engine/month-diff.js)
      const { diff, next, destructiveCount } = computeMonthDiff(prev, cells);

      // ===== DRY-RUN: devuelve el diff SIN persistir =====
      // La extensión lo usa para mostrar vista previa antes de confirmar.
      const dryRun = req.body?.cell?.dryRun === true || req.body?.dryRun === true;
      if (dryRun) {
        // Garantía de cero escrituras: resolveWorker puede haber marcado un
        // binding de actaisId (__bindActaisId) que loadData persistiría a los
        // 500ms. En dryRun lo descartamos — se vinculará en el apply real.
        for (const w of (data.workerMeta || [])) delete w.__bindActaisId;
        return res.json({
          ok: true,
          dryRun: true,
          worker: worker.name,
          workerId: worker.id,
          willCreate: !!toCreate,
          year, month,
          prev,
          diff,
          cellsChanged: diff.length,
          destructiveCount,
          message: (toCreate ? `${worker.name} se crearía en Shiftia. ` : '') + (diff.length === 0
            ? 'Sin cambios — la planilla del backend ya está sincronizada'
            : `${diff.length} celda(s) cambiarían para ${worker.name}` +
              (destructiveCount > 0 ? ` (${destructiveCount} se vaciarían)` : ''))
        });
      }

      // Apply con worker nuevo: materializar la creación antes de guardar
      if (toCreate) data.workerMeta.push(toCreate);

      // ===== DEFENSA: rechaza syncs destructivos =====
      // Si una sync va a vaciar 4+ celdas no-vacías, lo paramos.
      // Caso típico: extensión escanea durante render parcial de Actais y
      // ve celdas vacías que en realidad sí tenían datos.
      const allowDestructive = req.body?.cell?.allowDestructive === true;
      if (destructiveCount > 3 && !allowDestructive) {
        return res.json({
          ok: false,
          suspicious: true,
          reason: 'destructive-sync-blocked',
          cellsChanged: 0,
          destructiveCount,
          diff,
          worker: worker.name,
          message: `Se bloqueó por seguridad: ${destructiveCount} celdas perderían su valor (${prev.filter(Boolean).length} → ${next.filter(Boolean).length} celdas con datos). Causa probable: la extensión escaneó durante render parcial de Actais. Si es intencional, marca "Permitir vaciar" antes de reintentar.`
        });
      }

      if (!data.scheduleData[key]) data.scheduleData[key] = {};
      data.scheduleData[key][worker.id] = next;

      await pool.query(
        `INSERT INTO schedule_data (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = $2`,
        [req.user.id, data]
      );

      res.json({
        ok: true,
        worker: worker.name,
        workerId: worker.id,
        created: !!toCreate,
        year, month,
        diff,
        cellsChanged: diff.length,
        cellsTotal: 31,
        message: (toCreate ? `${worker.name} creado en Shiftia (actaisId ${worker.actaisId}). ` : '') +
          (diff.length === 0
            ? 'Sin cambios — la planilla del backend ya estaba sincronizada'
            : `${diff.length} celda(s) actualizada(s) para ${worker.name}`)
      });
    } catch (err) {
      console.error('[assistant.syncWorkerMonth]', err);
      res.status(500).json({ error: 'Error al sincronizar el mes' });
    }
  });

  // ============================================================================
  // /proposeAbsence — plan de cobertura para una ausencia
  // Body: { workerId|workerName, absenceType, startDate, endDate, reason? }
  //
  // Por cada día del rango: si el worker tiene turno laborable (M/T/N), busca
  // sustituto con buildCoverPlan. Si es D/L/LD/ausencia ya, marca "no-cover".
  // Devuelve plan día a día + estadísticas globales + reasoning explicativo.
  //
  // Catálogo de absenceTypes esperados:
  //   Largos: VAC, VAA, VAN, LAC, EX, BAJ, FOR
  //   Cortos: LD, AE, PM
  //   Variables: MTC, CJ
  // ============================================================================
  router.post('/proposeAbsence', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const worker = resolveWorker(data, p);
      if (!worker) {
        return res.json({
          ok: false, verdict: 'blocked', verdictLabel: 'Trabajador no identificado',
          error: workerNotFoundError(p, data),
          summary: buildSummary('proposeAbsence', null, p, { where: '?' })
        });
      }

      const cell = req.body?.cell || {};
      const absenceType = (cell.absenceType || 'VAC').toString().toUpperCase();
      const startISO = cell.startDate || cell.dayISO;
      const endISO   = cell.endDate   || cell.dayISO;
      if (!startISO || !endISO) {
        return res.json({ ok: false, error: 'Falta startDate / endDate (YYYY-MM-DD)' });
      }
      const [sy, sm, sd] = startISO.split('-').map(n => parseInt(n, 10));
      const [ey, em, ed] = endISO.split('-').map(n => parseInt(n, 10));
      if (!sy || !ey) return res.json({ ok: false, error: 'Fechas mal formateadas' });

      const start = new Date(sy, sm - 1, sd);
      const end   = new Date(ey, em - 1, ed);
      if (start > end) return res.json({ ok: false, error: 'startDate posterior a endDate' });
      const totalDaysRange = Math.round((end - start) / 86400000) + 1;
      if (totalDaysRange > 366) return res.json({ ok: false, error: 'Rango excesivo (máx 366 días)' });

      const days = [];
      for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
        const y = cur.getFullYear();
        const m = cur.getMonth();
        const d = cur.getDate() - 1;
        const dateISO = `${y}-${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
        const dayOfWeek = cur.getDay();
        const originalShift = engine.cellOf(data?.scheduleData || {}, y, m, worker.id, d);

        const isAlreadyAbsence = engine.UNAVAILABLE_CODES.includes(originalShift);
        const isRestDay = ['D', 'L', 'LD'].includes(originalShift);
        const isEmpty   = !originalShift;

        if (isAlreadyAbsence) {
          days.push({ dateISO, dayOfWeek, day: d, month: m, year: y, originalShift, status: 'already-absent', note: `Ya estaba en ${originalShift}` });
          continue;
        }
        if (isRestDay || isEmpty) {
          days.push({ dateISO, dayOfWeek, day: d, month: m, year: y, originalShift: originalShift || '∅', status: 'no-cover-needed', note: isRestDay ? `${originalShift}: descanso, sin cobertura` : 'Día sin asignar' });
          continue;
        }

        // Es turno laborable — buscar sustituto
        const dayParam = { year: y, month: m, day: d };
        const cp = buildCoverPlan(data, worker, dayParam, originalShift);
        const primary = cp?.primary?.candidate || null;
        const alternative = cp?.alternative?.candidate || null;

        days.push({
          dateISO, dayOfWeek, day: d, month: m, year: y,
          originalShift,
          status: primary ? 'covered' : 'no-substitute',
          primary, alternative,
          moreAvailable: cp?.moreCount || 0
        });
      }

      // Resumen
      const workDays = days.filter(x => x.status === 'covered' || x.status === 'no-substitute').length;
      const coveredDays = days.filter(x => x.status === 'covered').length;
      const uncoveredDays = days.filter(x => x.status === 'no-substitute').length;
      const restDays = days.filter(x => x.status === 'no-cover-needed').length;
      const alreadyAbsent = days.filter(x => x.status === 'already-absent').length;

      const verdict = uncoveredDays === 0 ? 'ok' : uncoveredDays <= 2 ? 'warning' : 'blocked';
      const verdictLabel = uncoveredDays === 0
        ? `Plan cubre las ${workDays} jornadas laborables`
        : `${uncoveredDays} día(s) sin sustituto`;

      // Construir reasoning
      const reasoning = [
        { rule: 'Rango analizado', status: 'pass', detail: `${totalDaysRange} día(s): ${startISO} → ${endISO}` },
        { rule: 'Tipo de ausencia', status: 'pass', detail: `${absenceType} ${ABSENCE_LABELS[absenceType] ? `· ${ABSENCE_LABELS[absenceType]}` : ''}` },
        { rule: 'Jornadas laborables a cubrir', status: 'pass', detail: `${workDays} de ${totalDaysRange}` },
        { rule: 'Días sin cobertura necesaria', status: 'pass', detail: `${restDays} (descansos) + ${alreadyAbsent} (ya en ausencia)` },
        { rule: 'Cobertura encontrada', status: coveredDays === workDays && workDays > 0 ? 'pass' : coveredDays > 0 ? 'warning' : (workDays > 0 ? 'fail' : 'pass'), detail: workDays === 0 ? 'Sin jornadas laborables en el rango' : `${coveredDays}/${workDays} días con sustituto legal` },
        { rule: 'Días huérfanos', status: uncoveredDays === 0 ? 'pass' : 'fail', detail: uncoveredDays === 0 ? 'Ninguno' : `${uncoveredDays} día(s) sin sustituto legal en planta` }
      ];

      res.json({
        ok: true,
        verdict, verdictLabel,
        worker: worker.name,
        summary: buildSummary('proposeAbsence', worker, p, {
          title: `Plan de ausencia · ${absenceType}`,
          what: `${ABSENCE_LABELS[absenceType] || absenceType} del ${startISO} al ${endISO}`,
          where: (PLANT_NAMES[worker.planta] || worker.planta || '?') + (worker.role ? ` · ${worker.role}` : '')
        }),
        reasoning,
        absencePlan: {
          absenceType,
          absenceLabel: ABSENCE_LABELS[absenceType] || absenceType,
          startDate: startISO,
          endDate: endISO,
          totalDaysRange,
          summary: { workDays, coveredDays, uncoveredDays, restDays, alreadyAbsent },
          days
        }
      });
    } catch (err) {
      console.error('[assistant.proposeAbsence]', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  router.post('/conv_maxNights', (req, res) => res.json({ value: SP_RULES.maxNightsPerMonth, label: 'Máximo de noches por mes', source: 'Convenio interno (configurable por trabajador)' }));
  router.post('/conv_weeklyRest', (req, res) => res.json({ value: SP_RULES.minWeeklyRestDays, label: 'Días de descanso semanal mínimo', source: 'Convenio' }));
  router.post('/conv_consecDays', (req, res) => res.json({ value: SP_RULES.maxConsecutiveDays, label: 'Días consecutivos trabajados máximo', source: 'Convenio' }));

  router.post('/historyOnCase', (req, res) => {
    res.json({ note: 'Función pendiente: aún no hay corpus histórico indexado. En esta versión devuelve vacío.', cases: [] });
  });

  // ============================================================================
  // Mantenimiento: limpia los actaisId mal vinculados en workerMeta.
  // Útil cuando la 1ª llamada con un cliente buggy bindeó a la persona incorrecta
  // (p.ej. la supervisora) al workerId de un empleado distinto. Tras llamar a
  // este endpoint, la siguiente Alt+click re-bindea cada worker por nombre.
  // ============================================================================
  router.post('/admin/clearBindings', async (req, res) => {
    try {
      const result = await pool.query('SELECT data FROM schedule_data WHERE user_id = $1', [req.user.id]);
      const data = result.rows[0]?.data || {};
      const all = data?.workerMeta || data?.workers || [];
      let cleared = 0;
      for (const w of all) {
        if (w.actaisId) {
          delete w.actaisId;
          cleared++;
        }
      }
      await pool.query(
        `INSERT INTO schedule_data (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = $2`,
        [req.user.id, data]
      );
      res.json({ ok: true, cleared, total: all.length, message: `Limpiados ${cleared} de ${all.length} bindings actaisId.` });
    } catch (err) {
      console.error('[assistant.admin.clearBindings]', err);
      res.status(500).json({ ok: false, error: 'Error al limpiar bindings' });
    }
  });

  return router;
}

module.exports = { buildAssistantRouter };
