export class BenchmarkError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BenchmarkError";
    this.code = code;
    this.details = details;
  }
}
