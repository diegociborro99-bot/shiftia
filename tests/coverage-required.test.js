// Regresión: getRequiredForShift / isWeekendOrHoliday usan day 1-based.
// El backend antes pasaba p.day (0-based) directamente → sábado tratado como
// viernes → cobertura weekday devuelta en fin de semana.
const assert = require('assert');
const engine = require('../engine/legality');

// Enero 2026: día 1 = Jueves, día 3 = Sábado, día 4 = Domingo.
// Cobertura weekday M para DUE: 3, weekend: 1.

// 1. isWeekendOrHoliday — input 1-based
assert.strictEqual(engine.isWeekendOrHoliday(2026, 0, 3), true,  'Sábado (1-based)');
assert.strictEqual(engine.isWeekendOrHoliday(2026, 0, 4), true,  'Domingo (1-based)');
assert.strictEqual(engine.isWeekendOrHoliday(2026, 0, 2), false, 'Viernes (1-based)');

// 2. Bug histórico: pasar 0-based daba el día anterior
// Sábado 3 0-based = 2 → new Date(2026,0,2).getDay() = 5 (vie) → NO weekend
assert.strictEqual(engine.isWeekendOrHoliday(2026, 0, 2), false,
  'Pasar day=2 (viernes 1-based) = no weekend, demuestra que sin el +1 daba mal');

// 3. getRequiredForShift para sábado lab DUE M:
// con 1-based → weekend → 1
assert.strictEqual(engine.getRequiredForShift('HEMATOLOGIA', 'enf', 'M', 2026, 0, 3), 1,
  'Sábado (1-based) en lab DUE = 1 cobertura M');
// 4. Para viernes M:
assert.strictEqual(engine.getRequiredForShift('HEMATOLOGIA', 'enf', 'M', 2026, 0, 2), 3,
  'Viernes (1-based) en lab DUE = 3 cobertura M');

// 5. Sábado en MICRO M:
assert.strictEqual(engine.getRequiredForShift('MICROBIOLOGIA', 'micro', 'M', 2026, 0, 3), 0,
  'Sábado en micro M = 0 (no cobertura fin de semana)');
// 6. Viernes en MICRO M:
assert.strictEqual(engine.getRequiredForShift('MICROBIOLOGIA', 'micro', 'M', 2026, 0, 2), 3,
  'Viernes en micro M = 3');

console.log('coverage-required: 7/7 OK');
