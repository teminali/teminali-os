'use strict';

const {
  normalizeSku,
  normalizeUnits,
  normalizeRequestId,
} = require('./normalize');
const { ConflictError, InsufficientStockError } = require('./errors');

class ReservationService {
  constructor(repository, initialStock = {}) {
    this.repository = repository;
    this.initialStock = { ...initialStock };
  }

  reserve(input) {
    const requestId = normalizeRequestId(input.requestId);
    const sku = normalizeSku(input.sku);
    const units = normalizeUnits(input.units);
    const available = this.initialStock[sku] || 0;
    if (available < units) throw new InsufficientStockError('insufficient stock');
    const event = { type: 'reserved', requestId, sku, units };
    this.repository.append(event);
    return { requestId, sku, units, status: 'active' };
  }

  release(input) {
    const requestId = normalizeRequestId(input.requestId);
    const events = this.repository.readAll();
    const reservation = events.find((event) => event.type === 'reserved' && event.requestId === requestId);
    if (!reservation) throw new ConflictError('reservation not found');
    this.repository.append({ type: 'released', requestId });
    return { requestId, sku: reservation.sku, units: reservation.units, status: 'released' };
  }

  snapshot() {
    const available = { ...this.initialStock };
    const reservations = {};
    for (const event of this.repository.readAll()) {
      if (event.type === 'reserved') {
        reservations[event.requestId] = { ...event, status: 'active' };
        available[event.sku] = (available[event.sku] || 0) - event.units;
      } else if (event.type === 'released' && reservations[event.requestId]) {
        const current = reservations[event.requestId];
        current.status = 'released';
        available[current.sku] += current.units;
      }
    }
    return { available, reservations };
  }
}

module.exports = { ReservationService };
