'use strict';

class ValidationError extends Error { constructor(message) { super(message); this.name = 'ValidationError'; } }
class ConflictError extends Error { constructor(message) { super(message); this.name = 'ConflictError'; } }
class InsufficientStockError extends Error { constructor(message) { super(message); this.name = 'InsufficientStockError'; } }

module.exports = { ValidationError, ConflictError, InsufficientStockError };
