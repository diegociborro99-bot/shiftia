// Integración: /syncWorkerMonth con dryRun no persiste y devuelve diff.
const assert = require('assert');
const express = require('express');
const request = require('supertest');
const { buildAssistantRouter } = require('../routes/assistant');

function makeApp(initialData) {
  const saves = [];
  const pool = {
    query: async (sql, params) => {
      if (/SELECT data FROM schedule_data/.test(sql)) {
        return { rows: [{ data: initialData }] };
      }
      if (/INSERT INTO schedule_data/.test(sql)) {
        saves.push(JSON.parse(JSON.stringify(params[1])));
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  const authMiddleware = (req, _res, next) => { req.user = { id: 1, email: 't@t' }; next(); };
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', buildAssistantRouter({ pool, authMiddleware }));
  return { app, saves };
}

const baseData = () => ({
  workerMeta: [{ id: 7, name: 'AVANZAS FERNANDEZ, SARA', role: 'enf', planta: 'p1n' }],
  scheduleData: { '2026-5': { 7: ['M','M','T','','D'] } }
});

(async () => {
  // 1. dryRun devuelve diff y NO guarda
  let { app, saves } = makeApp(baseData());
  let res = await request(app).post('/api/assistant/syncWorkerMonth').send({
    cell: { workerId: 7, year: 2026, month: 5, dryRun: true,
            cells: ['M','T','T','','D'] }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.dryRun, true);
  assert.deepStrictEqual(res.body.diff, [{ day: 1, from: 'M', to: 'T' }]);
  assert.strictEqual(res.body.cellsChanged, 1);
  assert.ok(Array.isArray(res.body.prev), 'dryRun expone prev para la preview');
  assert.strictEqual(saves.length, 0, 'dryRun no debe persistir');

  // 2. dryRun destructivo: informa destructiveCount, sigue sin guardar, no bloquea
  ({ app, saves } = makeApp(baseData()));
  res = await request(app).post('/api/assistant/syncWorkerMonth').send({
    cell: { workerId: 7, year: 2026, month: 5, dryRun: true, cells: ['','','','',''] }
  });
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.destructiveCount, 4);
  assert.strictEqual(saves.length, 0);

  // 3. Apply real (sin dryRun) sigue funcionando: guarda y devuelve diff
  ({ app, saves } = makeApp(baseData()));
  res = await request(app).post('/api/assistant/syncWorkerMonth').send({
    cell: { workerId: 7, year: 2026, month: 5, cells: ['M','T','T','','D'] }
  });
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.cellsChanged, 1);
  assert.strictEqual(saves.length >= 1, true, 'apply debe persistir');
  assert.strictEqual(saves[saves.length-1].scheduleData['2026-5'][7][1], 'T');

  // 4. Apply destructivo sin allowDestructive sigue bloqueado
  ({ app, saves } = makeApp(baseData()));
  res = await request(app).post('/api/assistant/syncWorkerMonth').send({
    cell: { workerId: 7, year: 2026, month: 5, cells: ['','','','',''] }
  });
  assert.strictEqual(res.body.ok, false);
  assert.strictEqual(res.body.suspicious, true);
  assert.strictEqual(saves.length, 0);


  // 5. dryRun NO persiste ni siquiera bindings de actaisId (resolveWorker por nombre)
  ({ app, saves } = makeApp(baseData()));
  res = await request(app).post('/api/assistant/syncWorkerMonth').send({
    cell: { workerId: 555888, workerName: 'AVANZAS FERNANDEZ, SARA', year: 2026, month: 5,
            dryRun: true, cells: ['M','T','T','','D'] }
  });
  assert.strictEqual(res.body.ok, true);
  await new Promise(r => setTimeout(r, 700)); // persistBindings se programa a 500ms
  assert.strictEqual(saves.length, 0, 'dryRun no debe persistir bindings actaisId');

  console.log('sync-dryrun: 5/5 OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
