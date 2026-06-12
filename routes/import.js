const express = require('express');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const { matchWorker, normalizeName } = require('../engine/name-matcher');
const { parsePlanningPdfText } = require('../engine/pdf-parser');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 200 }
});

// ============================================================================
// Shiftia Import — endpoint para subir planillas anuales en lote desde la
// extensión (o cualquier cliente). El parsing de PDFs se hace en el cliente;
// aquí solo recibimos el JSON estructurado, hacemos matching V2 con los
// workers existentes y mergeamos en data.workerMeta + data.scheduleData.
//
// Idempotente: re-subir el mismo PDF actualiza el plan del mes sin duplicar
// trabajadores. Si el matcher devuelve confidence < 70 marcamos el item como
// 'pending' y se lo devolvemos al cliente para que el gestor confirme.
// ============================================================================

function buildImportRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));
  router.use(authMiddleware);

  router.post('/pdf-batch', async (req, res) => {
    if (!req.body || !Array.isArray(req.body.schedules)) {
      return res.status(400).json({ error: 'Falta schedules[]' });
    }
    const schedules = req.body.schedules;
    if (schedules.length === 0) return res.json({ ok: true, summary: 'sin planillas', items: [] });

    let data;
    try {
      const result = await pool.query('SELECT data FROM schedule_data WHERE user_id = $1', [req.user.id]);
      data = result.rows[0]?.data || {};
    } catch (err) {
      console.error('[import.pdf-batch] load:', err);
      return res.status(500).json({ error: 'No se pudo cargar la data del usuario' });
    }

    if (!data.workerMeta) data.workerMeta = [];
    if (!data.scheduleData) data.scheduleData = {};

    let nextId = data.workerMeta.reduce((m, w) => Math.max(m, parseInt(w.id, 10) || 0), 0) + 1;
    const items = [];

    const confirmationsB = req.body?.confirmations || {};
    for (const sched of schedules) {
      const item = processSchedule(data, sched, () => nextId++, confirmationsB[sched.filename]);
      items.push(item);
    }

    try {
      await pool.query(
        `INSERT INTO schedule_data (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = $2`,
        [req.user.id, data]
      );
    } catch (err) {
      console.error('[import.pdf-batch] save:', err);
      return res.status(500).json({ error: 'No se pudo guardar la data del usuario' });
    }

    const summary = {
      processed: items.length,
      updated: items.filter(i => i.status === 'updated').length,
      created: items.filter(i => i.status === 'created').length,
      pending: items.filter(i => i.status === 'pending').length,
      failed: items.filter(i => i.status === 'failed').length
    };
    res.json({ ok: true, summary, items });
  });

  // ============================================================================
  // POST /api/import/pdf-upload (multipart/form-data, campo `files`)
  // Sube N PDFs de planificación anual. El backend extrae texto con pdf-parse,
  // parsea con engine/pdf-parser, y mergea cada planilla con la misma lógica
  // que /pdf-batch (matchWorker + merge idempotente).
  // ============================================================================
  router.post('/pdf-upload', upload.array('files', 200), async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Sin archivos. Envía files[] como multipart/form-data.' });
    }
    let confirmations = {};
    try { confirmations = JSON.parse(req.body?.confirmations || '{}'); } catch (_) {}

    let data;
    try {
      const result = await pool.query('SELECT data FROM schedule_data WHERE user_id = $1', [req.user.id]);
      data = result.rows[0]?.data || {};
    } catch (err) {
      console.error('[import.pdf-upload] load:', err);
      return res.status(500).json({ error: 'No se pudo cargar la data del usuario' });
    }
    if (!data.workerMeta) data.workerMeta = [];
    if (!data.scheduleData) data.scheduleData = {};

    let nextId = data.workerMeta.reduce((m, w) => Math.max(m, parseInt(w.id, 10) || 0), 0) + 1;
    const items = [];

    for (const file of req.files) {
      try {
        const { text } = await new PDFParse({ data: file.buffer }).getText();
        const parsed = parsePlanningPdfText(text);
        if (!parsed.ok) {
          items.push({ filename: file.originalname, status: 'failed', reason: parsed.error });
          continue;
        }
        const sched = {
          filename: file.originalname,
          workerName: parsed.workerName,
          year: parsed.year,
          role: parsed.role,
          plantaHint: parsed.plantaHint,
          categoria: parsed.categoria,
          scheduleByMonth: parsed.scheduleByMonth
        };
        const item = processSchedule(data, sched, () => nextId++, confirmations[file.originalname]);
        items.push(item);
      } catch (err) {
        console.error('[import.pdf-upload] file:', file.originalname, err);
        items.push({ filename: file.originalname, status: 'failed', reason: err.message || 'Error de parsing' });
      }
    }

    try {
      await pool.query(
        `INSERT INTO schedule_data (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = $2`,
        [req.user.id, data]
      );
    } catch (err) {
      console.error('[import.pdf-upload] save:', err);
      return res.status(500).json({ error: 'No se pudo guardar la data del usuario' });
    }

    const summary = {
      processed: items.length,
      updated: items.filter(i => i.status === 'updated').length,
      created: items.filter(i => i.status === 'created').length,
      pending: items.filter(i => i.status === 'pending').length,
      failed: items.filter(i => i.status === 'failed').length
    };
    res.json({ ok: true, summary, items });
  });

  // ============================================================================
  // POST /api/import/parsed-batch (application/json)
  //
  // Recibe planillas YA PARSEADAS por el cliente con pdf.js (mismo parser que
  // la web). El backend solo persiste — no hace text-extraction. Garantiza que
  // los PDFs se interpretan IDÉNTICO en web y extensión.
  //
  // Body esperado:
  //   { files: [{ ok, filename, workerName, year, role, plantaHint, categoria,
  //               scheduleByMonth: {0:[...],1:[...]}, monthHours, computoData,
  //               convenioData, monthsWithData, error? }] }
  // ============================================================================
  router.post('/parsed-batch', async (req, res) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const confirmations = req.body?.confirmations || {};
    if (files.length === 0) return res.status(400).json({ error: 'Sin archivos. Envía files[] en JSON.' });

    let data;
    try {
      const result = await pool.query('SELECT data FROM schedule_data WHERE user_id = $1', [req.user.id]);
      data = result.rows[0]?.data || {};
    } catch (err) {
      console.error('[import.parsed-batch] load:', err);
      return res.status(500).json({ error: 'No se pudo cargar la data del usuario' });
    }
    if (!data.workerMeta) data.workerMeta = [];
    if (!data.scheduleData) data.scheduleData = {};

    let nextId = data.workerMeta.reduce((m, w) => Math.max(m, parseInt(w.id, 10) || 0), 0) + 1;
    const items = [];

    for (const parsed of files) {
      if (!parsed || parsed.ok === false) {
        items.push({
          filename: parsed?.filename || '(sin nombre)',
          status: 'failed',
          reason: parsed?.error || 'Parse cliente falló'
        });
        continue;
      }
      if (!parsed.workerName) {
        items.push({ filename: parsed.filename, status: 'failed', reason: 'PDF sin nombre de trabajador detectado' });
        continue;
      }
      if (!parsed.scheduleByMonth || Object.keys(parsed.scheduleByMonth).length === 0) {
        items.push({ filename: parsed.filename, status: 'failed', reason: 'PDF sin meses parseados' });
        continue;
      }
      // Guardar también monthHours, computoData, convenioData en el worker tras processSchedule
      const item = processSchedule(data, parsed, () => nextId++, confirmations[parsed.filename]);
      // Adjuntar computo/convenio al worker (datos extra de la web)
      if (item.status === 'created' || item.status === 'updated') {
        const worker = data.workerMeta.find(w => String(w.id) === String(item.workerId));
        if (worker) {
          if (parsed.computoData?.noches != null) worker.nightsThisYear = parsed.computoData.noches;
          if (parsed.computoData?.reduccionNoches != null) worker.computoBalance = parsed.computoData.reduccionNoches;
          if (parsed.monthHours) worker.monthHours = parsed.monthHours;
          if (parsed.convenioData) worker.convenioData = parsed.convenioData;
        }
      }
      items.push(item);
    }

    try {
      await pool.query(
        `INSERT INTO schedule_data (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = $2`,
        [req.user.id, data]
      );
    } catch (err) {
      console.error('[import.parsed-batch] save:', err);
      return res.status(500).json({ error: 'No se pudo guardar la data del usuario' });
    }

    const summary = {
      processed: items.length,
      updated: items.filter(i => i.status === 'updated').length,
      created: items.filter(i => i.status === 'created').length,
      pending: items.filter(i => i.status === 'pending').length,
      failed: items.filter(i => i.status === 'failed').length
    };
    res.json({ ok: true, summary, items });
  });

  return router;
}

function processSchedule(data, sched, nextIdFn, confirmed) {
  // Estructura esperada del cliente:
  // { filename, workerName, year, role, plantaHint, actaisId,
  //   scheduleByMonth: { 0: ['','','M7H',...], 1: [...], ... } }
  if (!sched || !sched.workerName || !sched.year || !sched.scheduleByMonth) {
    return { filename: sched?.filename, status: 'failed', reason: 'Datos incompletos' };
  }
  const monthsKeys = Object.keys(sched.scheduleByMonth);
  if (monthsKeys.length === 0) return { filename: sched.filename, status: 'failed', reason: 'Sin meses' };

  // CONFIRMACIÓN MANUAL (items que quedaron 'pending'): el gestor eligió
  // destino explícito — workerId existente o '__new__' para crear.
  if (confirmed === '__new__') {
    const worker = {
      id: nextIdFn(), name: sched.workerName, role: sched.role || 'enf',
      planta: sched.plantaHint || null, flotante: false, modalidad: 'fijo',
      rules: {}, scheduleImported: true
    };
    if (sched.actaisId) worker.actaisId = sched.actaisId;
    data.workerMeta.push(worker);
    return mergeMonths(data, sched, worker, 'created', 100);
  }
  if (confirmed != null) {
    const worker = data.workerMeta.find(w => String(w.id) === String(confirmed));
    if (!worker) return { filename: sched.filename, status: 'failed', reason: 'Worker confirmado no existe (id ' + confirmed + ')' };
    return mergeMonths(data, sched, worker, 'updated', 100);
  }

  // Matching V2 contra workerMeta existente
  const matchResult = matchWorker(sched.workerName, data.workerMeta);

  let worker = matchResult.match;
  let status;

  if (worker) {
    // Match seguro: actualizar el worker existente
    status = 'updated';
    if (sched.actaisId) worker.actaisId = sched.actaisId;
    if (sched.role && !worker.role) worker.role = sched.role;
    if (sched.plantaHint && !worker.planta) worker.planta = sched.plantaHint;
  } else if (matchResult.confidence >= 40 && matchResult.candidates.length > 0) {
    // Match dudoso: devolver al cliente para confirmar manualmente
    return {
      filename: sched.filename,
      status: 'pending',
      workerName: sched.workerName,
      confidence: matchResult.confidence,
      candidates: matchResult.candidates.map(c => ({
        id: c.worker.id, name: c.worker.name, score: c.score
      }))
    };
  } else {
    // Sin match: crear worker nuevo
    worker = {
      id: nextIdFn(),
      name: sched.workerName,
      role: sched.role || 'enf',
      planta: sched.plantaHint || null,
      flotante: false,
      modalidad: 'fijo',
      rules: {},
      scheduleImported: true
    };
    if (sched.actaisId) worker.actaisId = sched.actaisId;
    data.workerMeta.push(worker);
    status = 'created';
  }

  return mergeMonths(data, sched, worker, status, matchResult.confidence);
}

// Merge de la planilla mes a mes (admite años parciales: solo los meses que vengan)
function mergeMonths(data, sched, worker, status, confidence) {
  const year = sched.year;
  let cellsMerged = 0;
  for (const monthStr of Object.keys(sched.scheduleByMonth)) {
    const month = parseInt(monthStr, 10);
    if (Number.isNaN(month) || month < 0 || month > 11) continue;
    const monthArr = sched.scheduleByMonth[monthStr];
    if (!Array.isArray(monthArr)) continue;
    const key = `${year}-${month}`;
    if (!data.scheduleData[key]) data.scheduleData[key] = {};
    data.scheduleData[key][worker.id] = monthArr.slice(0, 31);
    cellsMerged += monthArr.filter(Boolean).length;
  }
  return {
    filename: sched.filename,
    status,
    workerId: worker.id,
    workerName: worker.name,
    confidence,
    cellsMerged
  };
}

module.exports = { buildImportRouter };
