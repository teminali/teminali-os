import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

function tempFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `frontier-006-${label}-`));
  return path.join(dir, 'events.jsonl');
}

export async function evaluate(workspace) {
  let api;
  try {
    api = createRequire(import.meta.url)(path.join(workspace, 'src', 'index.js'));
  } catch (error) {
    return { score: 0, maxScore: 100, loadError: String(error), checks: [] };
  }
  const make = (stock = { WIDGET: 5 }, label = 'case') => {
    const file = tempFile(label);
    return { file, service: new api.ReservationService(new api.LedgerRepository(file), stock) };
  };
  const checks = [];
  async function check(id, points, run) {
    try { await run(); checks.push({ id, points, earned: points, passed: true }); }
    catch (error) { checks.push({ id, points, earned: 0, passed: false, error: `${error?.name || 'Error'}: ${error?.message || error}` }); }
  }
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const assertThrows = (run, name) => {
    try { run(); } catch (error) { if (!name || error?.name === name) return; throw error; }
    throw new Error(`expected ${name || 'an error'}`);
  };

  await check('normalization', 10, () => {
    assert(api.normalizeSku(' widget ') === 'WIDGET', 'SKU normalization');
    assert(api.normalizeRequestId(' r1 ') === 'r1', 'request normalization');
  });
  await check('strict-units', 10, () => {
    for (const value of ['2', 1.2, 0, -1, Number.MAX_SAFE_INTEGER + 1, NaN]) assertThrows(() => api.normalizeUnits(value), 'ValidationError');
    assert(api.normalizeUnits(2) === 2, 'valid units');
  });
  await check('stock-key-normalization', 5, () => {
    const { service } = make({ ' widget ': 3 }, 'stock-key');
    assert(service.reserve({ requestId: 'a', sku: 'WIDGET', units: 3 }).status === 'active', 'normalized stock key');
  });
  await check('aggregate-capacity', 10, () => {
    const { service } = make(undefined, 'capacity');
    service.reserve({ requestId: 'a', sku: 'WIDGET', units: 3 });
    assertThrows(() => service.reserve({ requestId: 'b', sku: 'WIDGET', units: 3 }), 'InsufficientStockError');
  });
  await check('reserve-idempotency', 10, () => {
    const { service } = make(undefined, 'reserve-idem');
    service.reserve({ requestId: 'a', sku: 'widget', units: 2 });
    service.reserve({ requestId: 'a', sku: ' WIDGET ', units: 2 });
    assert(Object.keys(service.snapshot().reservations).length === 1, 'one reservation');
    assert(service.snapshot().available.WIDGET === 3, 'charged once');
  });
  await check('intent-conflict', 8, () => {
    const { service } = make(undefined, 'conflict');
    service.reserve({ requestId: 'a', sku: 'WIDGET', units: 2 });
    assertThrows(() => service.reserve({ requestId: 'a', sku: 'WIDGET', units: 1 }), 'ConflictError');
  });
  await check('release-idempotency', 8, () => {
    const { service } = make(undefined, 'release-idem');
    service.reserve({ requestId: 'a', sku: 'WIDGET', units: 4 });
    service.release({ requestId: 'a' }); service.release({ requestId: 'a' });
    assert(service.snapshot().available.WIDGET === 5, 'restored once');
  });
  await check('reload', 5, () => {
    const { service, file } = make(undefined, 'reload');
    service.reserve({ requestId: 'a', sku: 'WIDGET', units: 2 }); service.release({ requestId: 'a' });
    const restored = new api.ReservationService(new api.LedgerRepository(file), { WIDGET: 5 });
    assert(restored.snapshot().reservations.a.status === 'released', 'released after reload');
  });
  await check('partial-tail-recovery', 8, () => {
    const { service, file } = make(undefined, 'tail');
    service.reserve({ requestId: 'a', sku: 'WIDGET', units: 2 });
    fs.appendFileSync(file, '{"type":"reserved"', 'utf8');
    assert(service.snapshot().available.WIDGET === 3, 'ignore incomplete final record');
  });
  await check('interior-corruption-rejected', 7, () => {
    const file = tempFile('interior');
    fs.writeFileSync(file, '{bad}\n{"type":"reserved","requestId":"a","sku":"WIDGET","units":1}\n', 'utf8');
    const repository = new api.LedgerRepository(file);
    assertThrows(() => repository.readAll(), 'SyntaxError');
  });
  await check('snapshot-isolation', 5, () => {
    const { service } = make(undefined, 'isolation');
    service.reserve({ requestId: 'a', sku: 'WIDGET', units: 2 });
    const first = service.snapshot(); first.available.WIDGET = 99; first.reservations.a.status = 'tampered';
    const second = service.snapshot();
    assert(second.available.WIDGET === 3 && second.reservations.a.status === 'active', 'defensive snapshot');
  });
  await check('unknown-release', 5, () => {
    const { service } = make(undefined, 'unknown-release');
    assertThrows(() => service.release({ requestId: 'missing' }), 'ConflictError');
  });
  await check('input-validation', 4, () => {
    const { service } = make(undefined, 'input');
    assertThrows(() => service.reserve(null), 'ValidationError');
    assertThrows(() => service.release(null), 'ValidationError');
  });
  await check('unknown-sku-capacity', 5, () => {
    const { service } = make(undefined, 'unknown-sku');
    assertThrows(() => service.reserve({ requestId: 'a', sku: 'OTHER', units: 1 }), 'InsufficientStockError');
  });
  return { score: checks.reduce((sum, item) => sum + item.earned, 0), maxScore: 100, checks };
}
