// Test-first: computeMonthDiff aún no existe — debe fallar.
const assert = require('assert');
const { computeMonthDiff } = require('../engine/month-diff');

// 1. Sin cambios
let r = computeMonthDiff(['M','T',''], ['M','T','']);
assert.deepStrictEqual(r.diff, []);
assert.strictEqual(r.destructiveCount, 0);

// 2. Cambio simple + normalización (trim, mayúsculas, null→'')
r = computeMonthDiff(['M','',''], [' t ', null, 'N']);
assert.deepStrictEqual(r.diff, [
  { day: 0, from: 'M', to: 'T' },
  { day: 2, from: '', to: 'N' }
]);
assert.strictEqual(r.destructiveCount, 0);
assert.strictEqual(r.next.length, 31, 'next siempre padded a 31');
assert.strictEqual(r.next[0], 'T');

// 3. Destructivo: celdas con valor que quedan vacías
r = computeMonthDiff(['M','T','N','M','T'], ['', '', '', '', '']);
assert.strictEqual(r.destructiveCount, 5);
assert.strictEqual(r.diff.length, 5);

// 4. prev undefined → tratado como mes vacío
r = computeMonthDiff(undefined, ['M']);
assert.deepStrictEqual(r.diff, [{ day: 0, from: '', to: 'M' }]);

// 5. next más largo de 31 se trunca
r = computeMonthDiff([], new Array(40).fill('M'));
assert.strictEqual(r.next.length, 31);
assert.strictEqual(r.diff.length, 31);

console.log('month-diff: 5/5 OK');
