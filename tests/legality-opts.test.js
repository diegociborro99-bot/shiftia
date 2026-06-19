// Tests del motor de legalidad: opts.purpose='cover' y opts.absentArea.
const assert = require('assert');
const engine = require('../engine/legality');

const workers = [
  { id: 1, name: 'Sara', role: 'DUE', planta: 'A', area: undefined, rules: { noCover: true, noSwap: true } },
  { id: 2, name: 'Sonia', role: 'DUE', planta: 'A', rules: { conciliacion: true } },
  { id: 3, name: 'Trinidad', role: 'TECNICO', planta: 'A', area: 'micro', rules: { noLab: true } },
  { id: 4, name: 'Beatriz', role: 'TECNICO', planta: 'A', rules: { noMicro: true } },
  { id: 5, name: 'Laura', role: 'DUE', planta: 'A', rules: {} },
];

// scheduleData: enero, 31 días, todos vacíos
const sd = { '2026-0': {} };
workers.forEach(w => { sd['2026-0'][w.id] = new Array(31).fill(''); });

// 1. noCover NO bloquea sin opts (validación genérica)
let r = engine.evaluateAssignment(1, 5, 'M', sd, workers, 2026, 0);
assert.strictEqual(r.legal, true, 'Sin opts.purpose, noCover NO debería bloquear');

// 2. noCover SÍ bloquea con purpose:'cover'
r = engine.evaluateAssignment(1, 5, 'M', sd, workers, 2026, 0, { purpose: 'cover' });
assert.strictEqual(r.legal, false, 'Con purpose:cover, noCover bloquea');
assert.ok(r.reasons.some(x => /cubre/i.test(x)), 'Razón menciona cubrir');

// 3. conciliacion + N bloquea siempre (no necesita cover purpose)
r = engine.evaluateAssignment(2, 5, 'N', sd, workers, 2026, 0);
assert.strictEqual(r.legal, false, 'conciliacion + N debería bloquear');

// 4. conciliacion + M pasa
r = engine.evaluateAssignment(2, 5, 'M', sd, workers, 2026, 0);
assert.strictEqual(r.legal, true, 'conciliacion + M permitido');

// 5. micro tec NO puede cubrir lab (purpose:cover + absentArea:'lab')
r = engine.evaluateAssignment(3, 5, 'M', sd, workers, 2026, 0, { purpose: 'cover', absentArea: 'lab' });
assert.strictEqual(r.legal, false, 'micro no cubre lab');

// 6. micro tec SÍ puede cubrir micro
r = engine.evaluateAssignment(3, 5, 'M', sd, workers, 2026, 0, { purpose: 'cover', absentArea: 'micro' });
assert.strictEqual(r.legal, true, 'micro cubre micro');

// 7. Beatriz (noMicro) NO puede cubrir micro
r = engine.evaluateAssignment(4, 5, 'M', sd, workers, 2026, 0, { purpose: 'cover', absentArea: 'micro' });
assert.strictEqual(r.legal, false, 'noMicro bloquea cobertura de micro');

// 8. Enfermera NO puede cubrir micro
r = engine.evaluateAssignment(5, 5, 'M', sd, workers, 2026, 0, { purpose: 'cover', absentArea: 'micro' });
assert.strictEqual(r.legal, false, 'enf no cubre micro');

// 9. RE / FFP / FLL son ausencias reconocidas (no se aceptan tras N como turno laboral)
assert.ok(engine.UNAVAILABLE_CODES.includes('RE'), 'RE debe estar en UNAVAILABLE_CODES');
assert.ok(engine.UNAVAILABLE_CODES.includes('FFP'), 'FFP debe estar en UNAVAILABLE_CODES');
assert.ok(engine.UNAVAILABLE_CODES.includes('FLL'), 'FLL debe estar en UNAVAILABLE_CODES');

// 10. Trabajador con día en RE NO está disponible
sd['2026-0'][5][5] = 'RE';
r = engine.evaluateAssignment(5, 5, 'M', sd, workers, 2026, 0, { purpose: 'cover', absentArea: 'lab' });
assert.strictEqual(r.legal, false, 'Día en RE no disponible');
assert.ok(r.reasons.some(x => /no disponible/i.test(x) || /\bRE\b/.test(x)), 'Razón menciona RE');
sd['2026-0'][5][5] = '';

console.log('legality-opts: 10/10 OK');
