export class GraphError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GraphError";
    this.code = code;
  }
}
