// Regresión: roleOf debe caer en w.type cuando w.role no encaja con los
// patrones conocidos (caso real: Sara = supervisora, no DUE/ENF). Antes
// devolvía null y los filtros del backend `!targetRole || roleOf(w)===tr`
// se abrían para todos los roles, dejando cruzar enf↔tec en /whoCovers.

const assert = require('assert');
const { roleOf } = require('../engine/legality');

// 1. Casos canónicos
assert.strictEqual(roleOf({ role: 'DUE' }),        'enf', 'DUE → enf');
assert.strictEqual(roleOf({ role: 'enf' }),        'enf', 'enf → enf');
assert.strictEqual(roleOf({ role: 'ENFERMERA' }),  'enf', 'ENFERMERA → enf');
assert.strictEqual(roleOf({ role: 'TECNICO' }),    'tec', 'TECNICO → tec');
assert.strictEqual(roleOf({ role: 'TEC' }),        'tec', 'TEC → tec');
assert.strictEqual(roleOf({ role: 'TÉCNICO' }),    'tec', 'TÉCNICO → tec');
assert.strictEqual(roleOf({ role: 'MICROBIOLOGIA' }), 'micro', 'MICROBIOLOGIA → micro');

// 2. Casos donde el role NO encaja — debe caer al campo type
assert.strictEqual(roleOf({ role: 'supervisora', type: 'enf' }), 'enf',
  'Sara (supervisora, type=enf) → enf por fallback');
assert.strictEqual(roleOf({ role: 'jefe', type: 'tec' }), 'tec',
  'Cualquier role raro con type=tec → tec por fallback');
assert.strictEqual(roleOf({ role: 'becaria', type: 'micro' }), 'micro',
  'role raro con type=micro → micro');

// 3. Si tampoco hay type → null (no podemos adivinar)
assert.strictEqual(roleOf({ role: 'cosa rara' }), null,
  'Sin role ni type reconocibles → null');
assert.strictEqual(roleOf({}), null, 'Worker vacío → null');
assert.strictEqual(roleOf(null), null, 'null → null');
assert.strictEqual(roleOf(undefined), null, 'undefined → null');

// 4. type prevalece sobre role bueno? NO — role tiene prioridad cuando encaja
// (esto es importante: si el role explícito dice una cosa, gana al type)
assert.strictEqual(roleOf({ role: 'DUE', type: 'tec' }), 'enf',
  'role canónico gana al type');

console.log('role-of: 13/13 OK');
