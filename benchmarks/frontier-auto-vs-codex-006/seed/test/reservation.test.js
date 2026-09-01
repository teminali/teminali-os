'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  LedgerRepository,
  ReservationService,
  ValidationError,
  InsufficientStockError,
  normalizeSku,
} = require('../src');

function service(stock = { WIDGET: 5 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-ledger-visible-'));
  return new ReservationService(new LedgerRepository(path.join(dir, 'events.jsonl')), stock);
}

test('exports typed domain errors', () => {
  assert.equal(new ValidationError('x').name, 'ValidationError');
  assert.equal(new InsufficientStockError('x').name, 'InsufficientStockError');
});

test('normalizes SKU keys consistently', () => {
  assert.equal(normalizeSku('  widget  '), 'WIDGET');
});

test('creates a basic reservation', () => {
  const api = service();
  assert.deepEqual(api.reserve({ requestId: 'r1', sku: 'WIDGET', units: 2 }), {
    requestId: 'r1', sku: 'WIDGET', units: 2, status: 'active',
  });
});

test('prevents aggregate overselling', () => {
  const api = service();
  api.reserve({ requestId: 'r1', sku: 'WIDGET', units: 3 });
  assert.throws(
    () => api.reserve({ requestId: 'r2', sku: 'WIDGET', units: 3 }),
    InsufficientStockError,
  );
});

test('same reserve request is idempotent', () => {
  const api = service();
  const first = api.reserve({ requestId: 'same', sku: 'WIDGET', units: 2 });
  const second = api.reserve({ requestId: 'same', sku: 'widget', units: 2 });
  assert.deepEqual(second, first);
  assert.equal(Object.keys(api.snapshot().reservations).length, 1);
});

test('release restores availability', () => {
  const api = service();
  api.reserve({ requestId: 'r1', sku: 'WIDGET', units: 4 });
  api.release({ requestId: 'r1' });
  assert.equal(api.snapshot().available.WIDGET, 5);
});

test('state survives service reconstruction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-ledger-reload-'));
  const file = path.join(dir, 'events.jsonl');
  new ReservationService(new LedgerRepository(file), { WIDGET: 5 })
    .reserve({ requestId: 'r1', sku: 'WIDGET', units: 2 });
  const restored = new ReservationService(new LedgerRepository(file), { WIDGET: 5 });
  assert.equal(restored.snapshot().available.WIDGET, 3);
});
