'use strict';

const {
  normalizeSku,
  normalizeUnits,
  normalizeRequestId,
} = require('./normalize');
const { ValidationError, ConflictError, InsufficientStockError } = require('./errors');

function validateInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
}

function normalizeInitialStock(initialStock) {
  if (initialStock === null || typeof initialStock !== 'object' || Array.isArray(initialStock)) {
    throw new ValidationError('initialStock must be an object');
  }

  const normalized = {};
  for (const [rawSku, units] of Object.entries(initialStock)) {
    const sku = normalizeSku(rawSku);
    if (Object.hasOwn(normalized, sku)) {
      throw new ValidationError(`duplicate initial stock SKU: ${sku}`);
    }
    if (typeof units !== 'number' || !Number.isSafeInteger(units) || units < 0) {
      throw new ValidationError('initial stock units must be a non-negative integer');
    }
    normalized[sku] = units;
  }
  return normalized;
}

function corruptLedger(message, cause) {
  const error = new SyntaxError(message);
  if (cause) error.cause = cause;
  return error;
}

class ReservationService {
  constructor(repository, initialStock = {}) {
    this.repository = repository;
    this.initialStock = normalizeInitialStock(initialStock);
  }

  reserve(input) {
    validateInput(input);
    const requestId = normalizeRequestId(input.requestId);
    const sku = normalizeSku(input.sku);
    const units = normalizeUnits(input.units);
    const state = this._replay();
    const existing = state.reservations[requestId];
    if (existing) {
      if (existing.sku !== sku || existing.units !== units) {
        throw new ConflictError('requestId was already used for a different reservation');
      }
      return { requestId, sku, units, status: existing.status };
    }

    const available = state.available[sku] ?? 0;
    if (available < units) throw new InsufficientStockError('insufficient stock');
    const event = { type: 'reserved', requestId, sku, units };
    this.repository.append(event);
    return { requestId, sku, units, status: 'active' };
  }

  release(input) {
    validateInput(input);
    const requestId = normalizeRequestId(input.requestId);
    const reservation = this._replay().reservations[requestId];
    if (!reservation) throw new ConflictError('reservation not found');
    if (reservation.status === 'released') {
      return { requestId, sku: reservation.sku, units: reservation.units, status: 'released' };
    }
    this.repository.append({ type: 'released', requestId });
    return { requestId, sku: reservation.sku, units: reservation.units, status: 'released' };
  }

  snapshot() {
    const state = this._replay();
    const available = { ...state.available };
    const reservations = {};
    for (const [requestId, reservation] of Object.entries(state.reservations)) {
      reservations[requestId] = { ...reservation };
    }
    return { available, reservations };
  }

  _replay() {
    const available = { ...this.initialStock };
    const reservations = {};
    for (const event of this.repository.readAll()) {
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        throw corruptLedger('ledger event must be an object');
      }
      if (event.type === 'reserved') {
        let requestId;
        let sku;
        let units;
        try {
          requestId = normalizeRequestId(event.requestId);
          sku = normalizeSku(event.sku);
          units = normalizeUnits(event.units);
        } catch (error) {
          throw corruptLedger('invalid reserved ledger event', error);
        }

        const current = reservations[requestId];
        if (current) {
          if (current.sku !== sku || current.units !== units) {
            throw corruptLedger('requestId has conflicting reservation events');
          }
          continue;
        }
        reservations[requestId] = { type: 'reserved', requestId, sku, units, status: 'active' };
        available[sku] = (available[sku] ?? 0) - units;
      } else if (event.type === 'released') {
        let requestId;
        try {
          requestId = normalizeRequestId(event.requestId);
        } catch (error) {
          throw corruptLedger('invalid released ledger event', error);
        }
        const current = reservations[requestId];
        if (!current) throw corruptLedger('release has no matching reservation');
        if (current.status === 'active') {
          current.status = 'released';
          available[current.sku] = (available[current.sku] ?? 0) + current.units;
        }
      } else {
        throw corruptLedger('unknown ledger event type');
      }
    }
    return { available, reservations };
  }
}

module.exports = { ReservationService };
