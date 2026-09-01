export class GatewayError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.details = options.details;
  }
}

export function classifyUpstreamStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function publicError(error, correlationId) {
  const known = error instanceof GatewayError;
  return {
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "The gateway could not complete the request.",
      retryable: known ? error.retryable : false,
      correlationId,
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  };
}
