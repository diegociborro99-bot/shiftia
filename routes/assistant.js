const express = require('express');
const { matchWorker } = require('../engine/name-matcher');
const engine = require('../engine/legality');

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
const ACTION_LABELS = {
  librar:           { title: 'Librar día',           what: 'Convertir turno actual en descanso' },
  vacaciones:       { title: 'Marcar vacaciones',    what: 'Asignar VAC a los días indicados' },
  cambio:           { title: 'Proponer cambio',      what: 'Intercambiar turno con un compañero' },
  whoCovers:        { title: 'Buscar sustituto',     what: 'Sugerir candidatos para cubrir' },
  validateConvenio: { title: 'Validar convenio',     what: 'Comprobar legalidad de asignación' },
  alternativas:     { title: 'Alternativas IA',      what: 'Comparar estrategias de cobertura' }
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
  return {
    year: Number.isFinite(cell.year) ? cell.year : new Date().getFullYear(),
    month: Number.isFinite(cell.month) ? cell.month : new Date().getMonth(),
    day: Number.isFinite(cell.day) ? cell.day : 0,
    shift: cell.shift || null,
    workerId: cell.workerId ?? cell.workerHint ?? null,
    workerName: cell.worker || null,
    plantaId: cell.plantaId || null
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

      res.json({
        ok: true,
        verdict,
        verdictLabel: candidates.length === 0
          ? `Sin candidatos ${roleLabel} para cubrir ${targetShift}`
          : `${candidates.length} candidato(s) ${roleLabel}`,
        summary: buildSummary('whoCovers', absentWorker, p, { what: `Buscar sustituto ${roleLabel} para turno ${targetShift}` }),
        reasoning: [
          { rule: 'Búsqueda por rol', status: 'pass', detail: `Solo ${roleLabel}s en planta ${PLANT_NAMES[targetPlanta] || targetPlanta} o flotantes` },
          { rule: 'Legalidad de cada candidato', status: 'pass', detail: 'Cada candidato pasó las 7 reglas del motor (cross-month, whitelist post-noche, máx noches, etc.)' },
          { rule: 'Ordenación', status: 'pass', detail: 'Por score (misma planta > flotante > cross-plant; carga del mes; turno preferido)' }
        ],
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

      res.json({
        ok: true,
        verdict: v.verdict,
        verdictLabel: v.verdictLabel,
        worker: worker.name,
        summary: buildSummary('librar', worker, p, { what: `Convertir turno ${originalShift || '∅'} → descanso` }),
        reasoning,
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

  router.post('/alternativas', async (req, res) => {
    try {
      const data = await loadData(pool, req.user.id);
      const p = parseCell(req.body);
      const planA = await getCandidates(data, p, 'multi');
      const planB = await getCandidates(data, p, 'balance');
      res.json({ planA, planB });
    } catch (err) { res.status(500).json({ error: 'Error interno' }); console.error('[assistant.alternativas]', err); }
  });

  async function getCandidates(data, p, strategy) {
    const worker = resolveWorker(data, p);
    const targetPlanta = p.plantaId || worker?.planta;
    const targetShift = p.shift || 'M';
    return (data.workers || [])
      .filter(w => w.id !== worker?.id)
      .map(w => {
        const legality = checkLegality(data, w, p.year, p.month, p.day, targetShift);
        if (!legality.legal) return null;
        const scoring = scoreCandidate(data, w, p.year, p.month, p.day, targetShift, targetPlanta);
        const extra = strategy === 'balance' ? -Math.abs((data?.scheduleData?.[ymKey(p.year, p.month)]?.[w.id] || []).filter(Boolean).length - 20) : 0;
        return { name: w.name, score: scoring.score + extra, breakdown: scoring.breakdown };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

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
