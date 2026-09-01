'use strict';

const { normalizeSku, normalizeUnits, normalizeRequestId } = require('./normalize');
const { ConflictError, InsufficientStockError, ValidationError } = require('./errors');

class ReservationService {
  constructor(repository, initialStock = {}) {
    this.repository = repository;
    this.initialStock = {};
    for (const [sku, units] of Object.entries(initialStock)) {
      this.initialStock[normalizeSku(sku)] = normalizeUnits(units);
    }
  }

  reserve(input) {
    if (!input || typeof input !== 'object') throw new ValidationError('input must be an object');
    const intent = {
      requestId: normalizeRequestId(input.requestId),
      sku: normalizeSku(input.sku),
      units: normalizeUnits(input.units),
    };
    const prior = this.snapshot().reservations[intent.requestId];
    if (prior) {
      if (prior.sku !== intent.sku || prior.units !== intent.units) throw new ConflictError('requestId already used for different intent');
      return { requestId: prior.requestId, sku: prior.sku, units: prior.units, status: prior.status };
    }
    const state = this.snapshot();
    if ((state.available[intent.sku] || 0) < intent.units) throw new InsufficientStockError('insufficient stock');
    this.repository.append({ type: 'reserved', ...intent });
    return { ...intent, status: 'active' };
  }

  release(input) {
    if (!input || typeof input !== 'object') throw new ValidationError('input must be an object');
    const requestId = normalizeRequestId(input.requestId);
    const prior = this.snapshot().reservations[requestId];
    if (!prior) throw new ConflictError('reservation not found');
    if (prior.status === 'released') return { requestId, sku: prior.sku, units: prior.units, status: 'released' };
    this.repository.append({ type: 'released', requestId });
    return { requestId, sku: prior.sku, units: prior.units, status: 'released' };
  }

  snapshot() {
    const available = { ...this.initialStock };
    const reservations = {};
    for (const event of this.repository.readAll()) {
      if (!event || typeof event !== 'object') continue;
      if (event.type === 'reserved') {
        if (reservations[event.requestId]) throw new ConflictError('duplicate reservation event');
        reservations[event.requestId] = { requestId: event.requestId, sku: event.sku, units: event.units, status: 'active' };
        available[event.sku] = (available[event.sku] || 0) - event.units;
      } else if (event.type === 'released') {
        const current = reservations[event.requestId];
        if (!current) throw new ConflictError('release without reservation');
        if (current.status !== 'released') {
          current.status = 'released';
          available[current.sku] += current.units;
        }
      }
    }
    return { available: { ...available }, reservations: Object.fromEntries(Object.entries(reservations).map(([key, value]) => [key, { ...value }])) };
  }
}

module.exports = { ReservationService };
