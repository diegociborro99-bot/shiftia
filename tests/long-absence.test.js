// Integración: setStatus + exclusión de candidatos en whoCovers.
const assert = require('assert');
const express = require('express');
const request = require('supertest');
const { buildAssistantRouter } = require('../routes/assistant');

function makeApp(initialData) {
  const saves = [];
  const pool = {
    query: async (sql, params) => {
      if (/SELECT data FROM schedule_data/.test(sql)) return { rows: [{ data: initialData }] };
      if (/INSERT INTO schedule_data/.test(sql)) { saves.push(JSON.parse(JSON.stringify(params[1]))); return { rows: [] }; }
      return { rows: [] };
    }
  };
  const authMiddleware = (req, _res, next) => { req.user = { id: 1 }; next(); };
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', buildAssistantRouter({ pool, authMiddleware }));
  return { app, saves };
}

// Diego trabaja M el día 25 (índice 24); Iris y Marta libran ese día → candidatas.
const month = new Array(31).fill('D');
const baseData = () => ({
  workerMeta: [
    { id: 1, name: 'CIBORRO GONZALEZ, DIEGO', role: 'enf', planta: 'hema' },
    { id: 2, name: 'VELARDE GONZALEZ, IRIS', role: 'enf', planta: 'hema' },
    { id: 3, name: 'VALLE GARCIA, MARTA', role: 'enf', planta: 'hema' }
  ],
  scheduleData: { '2026-5': {
    1: month.map((c, i) => (i === 24 ? 'M' : 'D')),
    2: new Array(31).fill('D'),
    3: new Array(31).fill('D')
  } }
});

(async () => {
  // 1. setStatus marca la baja indefinida y persiste
  let { app, saves } = makeApp(baseData());
  let res = await request(app).post('/api/assistant/worker/setStatus').send({
    cell: { workerName: 'VELARDE GONZALEZ, IRIS', code: 'BAJ', label: 'Baja maternidad', since: '2026-05-01' }
  });
  assert.strictEqual(res.body.ok, true, JSON.stringify(res.body));
  assert.strictEqual(res.body.longAbsence.code, 'BAJ');
  assert.strictEqual(res.body.longAbsence.until, null);
  assert.ok(saves.length >= 1, 'setStatus persiste');
  assert.strictEqual(saves[saves.length-1].workerMeta.find(w => w.id === 2).longAbsence.label, 'Baja maternidad');

  // 2. whoCovers EXCLUYE a Iris y lo explica
  const data = baseData();
  data.workerMeta[1].longAbsence = { code: 'BAJ', label: 'Baja maternidad', since: '2026-05-01', until: null };
  ({ app } = makeApp(data));
  res = await request(app).post('/api/assistant/whoCovers').send({
    cell: { workerId: 1, year: 2026, month: 5, day: 24, shift: 'M' }
  });
  assert.strictEqual(res.body.ok, true);
  const names = (res.body.candidates || []).map(c => c.name);
  assert.ok(!names.includes('VELARDE GONZALEZ, IRIS'), 'Iris no puede ser candidata');
  assert.ok(names.includes('VALLE GARCIA, MARTA'), 'Marta sí');
  assert.ok((res.body.reasoning || []).some(r => /IRIS/i.test(r.detail || '') && /baja/i.test(r.detail || '')),
    'el razonamiento menciona la exclusión de Iris');
  const planNames = [res.body.coverPlan?.primary?.candidate?.name, res.body.coverPlan?.alternative?.candidate?.name].filter(Boolean);
  assert.ok(!planNames.includes('VELARDE GONZALEZ, IRIS'), 'tampoco en el coverPlan');

  // 3. Quitar la baja (code null) → vuelve a ser candidata
  ({ app, saves } = makeApp(data));
  res = await request(app).post('/api/assistant/worker/setStatus').send({
    cell: { workerName: 'VELARDE GONZALEZ, IRIS', code: null }
  });
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.longAbsence, null);
  assert.strictEqual(saves[saves.length-1].workerMeta.find(w => w.id === 2).longAbsence, undefined);

  console.log('long-absence: 3/3 OK');
})().catch(e => { console.error(e); process.exit(1); });
