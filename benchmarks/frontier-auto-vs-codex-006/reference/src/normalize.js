'use strict';

const { ValidationError } = require('./errors');

function normalizeSku(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError('sku must be a non-empty string');
  return value.trim().toUpperCase();
}

function normalizeUnits(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('units must be a positive safe integer');
  }
  return value;
}

function normalizeRequestId(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError('requestId must be a non-empty string');
  return value.trim();
}

module.exports = { normalizeSku, normalizeUnits, normalizeRequestId };
