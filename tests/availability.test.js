// Test-first: engine/availability.js aún no existe.
const assert = require('assert');
const { isOnLongAbsence } = require('../engine/availability');

const iris = { name: 'VELARDE GONZALEZ, IRIS',
  longAbsence: { code: 'BAJ', label: 'Baja maternidad', since: '2026-05-01', until: null } };

assert.strictEqual(isOnLongAbsence(iris, '2026-06-26'), true, 'baja indefinida activa');
assert.strictEqual(isOnLongAbsence(iris, '2026-04-30'), false, 'antes del inicio no');
assert.strictEqual(isOnLongAbsence({ name: 'X' }, '2026-06-26'), false, 'sin longAbsence');
assert.strictEqual(isOnLongAbsence(null, '2026-06-26'), false);

const acotada = { longAbsence: { code: 'EX', since: '2026-01-01', until: '2026-03-31' } };
assert.strictEqual(isOnLongAbsence(acotada, '2026-02-15'), true);
assert.strictEqual(isOnLongAbsence(acotada, '2026-04-01'), false, 'tras el fin vuelve a estar disponible');

// Sin "since" → activa desde siempre hasta el "until"
assert.strictEqual(isOnLongAbsence({ longAbsence: { code: 'BAJ' } }, '2030-01-01'), true);

console.log('availability: 7/7 OK');
