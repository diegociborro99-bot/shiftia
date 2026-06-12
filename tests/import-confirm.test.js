// Test-first: confirmación manual de planillas 'pending' (caso Amanda 55%).
const assert = require('assert');
const express = require('express');
const request = require('supertest');
const { buildImportRouter } = require('../routes/import');

function makeApp(initialData) {
  const saves = [];
  const pool = {
    query: async (sql, params) => {
      if (/SELECT data/.test(sql)) return { rows: [{ data: initialData }] };
      if (/INSERT INTO/.test(sql)) { saves.push(JSON.parse(JSON.stringify(params[1]))); return { rows: [] }; }
      return { rows: [] };
    }
  };
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/import', buildImportRouter({ pool, authMiddleware: (req, _r, n) => { req.user = { id: 1 }; n(); } }));
  return { app, saves };
}

// En Shiftia existe "BARROZO GONZALEZ, AMANDA"; el PDF dice "BARROSO GONZALEZ, AMANDA"
const baseData = () => ({
  workerMeta: [
    { id: 1, name: 'BARROZO GONZALEZ, AMANDA', role: 'enf' },
    { id: 2, name: 'CALVO FERNANDEZ, LAURA', role: 'enf' }
  ],
  scheduleData: {}
});

const amandaPdf = {
  ok: true, filename: 'amanda.pdf', workerName: 'BARROSO GONZALEZ, AMANDA',
  year: 2026, scheduleByMonth: { 6: ['M','T','D'], 7: ['D','M','M'] } // solo medio año: válido
};

(async () => {
  // 1. Sin confirmación → pending con candidatas (comportamiento actual)
  let { app, saves } = makeApp(baseData());
  let res = await request(app).post('/api/import/parsed-batch').send({ files: [amandaPdf] });
  const item = res.body.items[0];
  if (item.status === 'pending') {
    assert.ok(item.candidates.length > 0, 'ofrece candidatas');
  } // (si el matcher mejora y matchea directo, también vale)

  // 2. Confirmación a un worker EXISTENTE → updated, meses mergeados (aunque sea medio año)
  ({ app, saves } = makeApp(baseData()));
  res = await request(app).post('/api/import/parsed-batch').send({
    files: [amandaPdf], confirmations: { 'amanda.pdf': 1 }
  });
  assert.strictEqual(res.body.items[0].status, 'updated', JSON.stringify(res.body.items[0]));
  assert.strictEqual(res.body.items[0].workerId, 1);
  const saved = saves[saves.length - 1];
  assert.deepStrictEqual(saved.scheduleData['2026-6'][1].slice(0, 3), ['M','T','D']);
  assert.deepStrictEqual(saved.scheduleData['2026-7'][1].slice(0, 3), ['D','M','M']);

  // 3. Confirmación "__new__" → crea trabajador nuevo con el nombre del PDF
  ({ app, saves } = makeApp(baseData()));
  res = await request(app).post('/api/import/parsed-batch').send({
    files: [amandaPdf], confirmations: { 'amanda.pdf': '__new__' }
  });
  assert.strictEqual(res.body.items[0].status, 'created', JSON.stringify(res.body.items[0]));
  const saved2 = saves[saves.length - 1];
  assert.ok(saved2.workerMeta.find(w => w.name === 'BARROSO GONZALEZ, AMANDA'));

  console.log('import-confirm: 3/3 OK');
})().catch(e => { console.error(e); process.exit(1); });
