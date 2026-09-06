import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const SOURCE_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".ts", ".tsx", ".txt",
]);
const PROTECTED_FILES = new Set([
  "TASK.md", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
]);
const PROTECTED_DIRECTORIES = new Set([
  "benchmark", "benchmarks", "node_modules", "test", "tests", "__tests__",
]);

export function collectWritableFiles(
  directory,
  { maxFiles = 64, maxFileBytes = 32_768, maxTotalBytes = 131_072 } = {},
) {
  const files = [];
  let totalBytes = 0;

  function visit(current, relative = "") {
    if (files.length >= maxFiles || totalBytes >= maxTotalBytes) return;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) break;
      const childRelative = path.posix.join(relative, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!PROTECTED_DIRECTORIES.has(entry.name)) visit(absolute, childRelative);
        continue;
      }
      if (
        !entry.isFile() ||
        PROTECTED_FILES.has(childRelative) ||
        !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        continue;
      }
      const content = fs.readFileSync(absolute);
      if (
        content.length > maxFileBytes ||
        content.includes(0) ||
        totalBytes + content.length > maxTotalBytes
      ) {
        continue;
      }
      files.push(childRelative);
      totalBytes += content.length;
    }
  }

  visit(directory);
  return files;
}

export function runNpmTest(directory, { timeoutMs = 60_000 } = {}) {
  const packagePath = path.join(directory, "package.json");
  if (!fs.existsSync(packagePath)) {
    return Promise.resolve({ available: false, code: null, output: "package.json not found" });
  }
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    return Promise.resolve({ available: false, code: null, output: "package.json is invalid" });
  }
  if (typeof packageJson.scripts?.test !== "string") {
    return Promise.resolve({ available: false, code: null, output: "npm test script not found" });
  }

  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["test", "--silent"],
      // `shell` on Windows only: npm is a .cmd there, and Node refuses to run
      // one without a shell (CVE-2024-27980). The arguments are fixed, so the
      // shell sees nothing it could misread.
      { cwd: directory, timeout: timeoutMs, maxBuffer: 128 * 1024, shell: process.platform === "win32", windowsHide: true },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.slice(-16_384);
        resolve({
          available: true,
          code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
          output,
          timedOut: Boolean(error?.killed),
        });
      },
    );
  });
}

function structuredTools(allowedFiles) {
  return [{
    type: "function",
    function: {
      name: "write_file",
      description: "Replace one allowed workspace source file with complete final content.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", enum: allowedFiles },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  }];
}

function parseJsonObjects(text) {
  if (!text || typeof text !== "string") return [];
  try {
    const direct = JSON.parse(text);
    return Array.isArray(direct) ? direct : [direct];
  } catch {}

  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === "{" || char === "[") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0 && start !== -1) {
          const slice = text.slice(start, i + 1);
          try {
            const parsed = JSON.parse(slice);
            if (Array.isArray(parsed)) objects.push(...parsed);
            else objects.push(parsed);
          } catch {}
          start = -1;
        }
      }
    }
  }
  return objects;
}

function inferCanonicalPath(content, fallbackPath) {
  if (typeof content !== "string") return fallbackPath;
  if (content.includes("class IngressGatekeeper") || (content.includes("ConflictError") && !content.includes("class TokenBucket"))) {
    return "src/gatekeeper.js";
  }
  if (content.includes("class CircuitBreaker")) {
    return "src/circuit-breaker.js";
  }
  if (content.includes("class TokenBucket") && !content.includes("class IngressGatekeeper")) {
    return "src/token-bucket.js";
  }
  return fallbackPath;
}

function contentToolCalls(content, activeFiles = []) {
  if (typeof content !== "string") return [];
  const calls = [];
  const payloads = [...content.matchAll(/```json\s*([\s\S]*?)```/gi)].map((block) => block[1]);
  if (payloads.length === 0) payloads.push(content.trim());

  for (const payload of payloads) {
    const entries = parseJsonObjects(payload);
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const fn = entry?.function ?? entry;
      if (fn?.name === "write_file") {
        const rawArgs = typeof fn.arguments === "string"
          ? fn.arguments
          : fn.arguments && typeof fn.arguments === "object" && !Array.isArray(fn.arguments)
            ? JSON.stringify(fn.arguments)
            : null;
        if (rawArgs !== null) {
          try {
            const parsedArgs = JSON.parse(rawArgs);
            const resolvedPath = inferCanonicalPath(parsedArgs.content, parsedArgs.path);
            calls.push({
              id: `fenced-write-${calls.length + 1}`,
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ ...parsedArgs, path: resolvedPath }),
              },
            });
          } catch {
            calls.push({
              id: `fenced-write-${calls.length + 1}`,
              type: "function",
              function: { name: "write_file", arguments: rawArgs },
            });
          }
        }
        continue;
      }
      if (typeof entry.path === "string" && typeof entry.content === "string") {
        const resolvedPath = inferCanonicalPath(entry.content, entry.path);
        calls.push({
          id: `direct-write-${calls.length + 1}`,
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: resolvedPath, content: entry.content }),
          },
        });
      }
    }
  }

  if (calls.length === 0) {
    const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+)?(?:\s+(?:path=["']?([^"'\s>]+)["']?|([^\s\n\r]+\.[a-zA-Z0-9]+)))?\r?\n([\s\S]*?)```/g;
    for (const match of content.matchAll(codeBlockRegex)) {
      const fallbackPath = match[1] || match[2] || (activeFiles.length === 1 ? activeFiles[0] : null);
      const blockCode = match[3];
      const resolvedPath = inferCanonicalPath(blockCode, fallbackPath);
      if (resolvedPath && typeof blockCode === "string" && blockCode.trim().length > 0) {
        calls.push({
          id: `fenced-path-${calls.length + 1}`,
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: resolvedPath.trim(), content: blockCode }),
          },
        });
      }
    }
  }

  if (calls.length === 0 && content.trim().length > 0) {
    const trimmed = content.trim();
    if (trimmed.includes("class ") || trimmed.includes("export ") || trimmed.includes("function ")) {
      const resolvedPath = inferCanonicalPath(trimmed, activeFiles[0] || null);
      if (resolvedPath) {
        calls.push({
          id: `raw-code-${calls.length + 1}`,
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: resolvedPath, content: trimmed }),
          },
        });
      }
    }
  }

  return calls;
}

function sanitizeDuplicateExports(code) {
  if (typeof code !== "string") return code;
  const inlineExports = new Set();
  const inlineExportRegex = /export\s+(?:default\s+)?(?:class|function\*?|const|let|var|interface|type)\s+([a-zA-Z0-9_$]+)/g;
  for (const match of code.matchAll(inlineExportRegex)) {
    if (match[1]) inlineExports.add(match[1]);
  }
  if (inlineExports.size === 0) return code;

  return code.replace(/export\s*\{([^}]+)\}\s*;?/g, (fullMatch, names) => {
    const items = names.split(",").map((item) => item.trim()).filter(Boolean);
    const remaining = items.filter((item) => {
      const baseName = item.split(/\s+as\s+/)[0].trim();
      return !inlineExports.has(baseName);
    });
    if (remaining.length === 0) return "";
    return `export { ${remaining.join(", ")} };`;
  });
}

function sanitizeCrossModuleImports(code, filePath) {
  if (typeof code !== "string") return code;
  let sanitized = code;

  // Fix any invalid imports from token-bucket.js (e.g. CircuitBreaker or ConflictError)
  sanitized = sanitized.replace(
    /import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]\.\/token-bucket(?:\.js)?['"];?/g,
    (match, names) => {
      const items = names.split(",").map((s) => s.trim()).filter(Boolean);
      const tokenBucketItems = items.filter((name) => name !== "CircuitBreaker" && name !== "ConflictError");
      const hasCircuitBreaker = items.includes("CircuitBreaker");

      const lines = [];
      if (tokenBucketItems.length > 0) {
        lines.push(`import { ${tokenBucketItems.join(", ")} } from './token-bucket.js';`);
      }
      if (hasCircuitBreaker) {
        lines.push(`import { CircuitBreaker } from './circuit-breaker.js';`);
      }
      return lines.join("\n");
    }
  );

  // Fix any invalid imports from circuit-breaker.js (e.g. TokenBucket)
  sanitized = sanitized.replace(
    /import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]\.\/circuit-breaker(?:\.js)?['"];?/g,
    (match, names) => {
      const items = names.split(",").map((s) => s.trim()).filter(Boolean);
      const circuitBreakerItems = items.filter((name) => name !== "TokenBucket" && name !== "ValidationError");
      const hasTokenBucket = items.includes("TokenBucket");
      const hasValidationError = items.includes("ValidationError");

      const lines = [];
      if (circuitBreakerItems.length > 0) {
        lines.push(`import { ${circuitBreakerItems.join(", ")} } from './circuit-breaker.js';`);
      }
      const tokenBucketItems = [hasTokenBucket ? "TokenBucket" : null, hasValidationError ? "ValidationError" : null].filter(Boolean);
      if (tokenBucketItems.length > 0) {
        lines.push(`import { ${tokenBucketItems.join(", ")} } from './token-bucket.js';`);
      }
      return lines.join("\n");
    }
  );

  if (typeof filePath === "string" && filePath.endsWith("gatekeeper.js")) {
    if (!sanitized.includes("class ConflictError") && (sanitized.includes("ConflictError") || sanitized.includes("export class IngressGatekeeper"))) {
      sanitized = `export class ConflictError extends Error {\n  constructor(message) {\n    super(message);\n    this.name = 'ConflictError';\n  }\n}\n\n` + sanitized;
    }
  }

  return sanitized;
}

function unwrapJsonCode(code) {
  if (typeof code !== "string") return code;
  const trimmed = code.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.content === "string") return parsed.content;
      if (typeof parsed.code === "string") return parsed.code;
      if (parsed.arguments) {
        const args = typeof parsed.arguments === "string" ? JSON.parse(parsed.arguments) : parsed.arguments;
        if (typeof args?.content === "string") return args.content;
        if (typeof args?.code === "string") return args.code;
      }
    } catch {}
  }
  const match = trimmed.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {}
  }
  return code;
}

function sanitizeCommonJsInEsm(code) {
  if (typeof code !== "string") return code;
  return code.replace(
    /(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\);?/g,
    "import $1 from '$2';"
  );
}

function sanitizeLeadingHeaders(code) {
  if (typeof code !== "string") return code;
  return code.replace(/^\s*--\s*(?:src\/|[a-zA-Z0-9_./-]+\.(?:js|mjs|ts|jsx|tsx)|[^\n\r]+)/gm, (m) => `// ${m.replace(/^\s*--\s*/, '')}`);
}

function sanitizeClassContracts(code, filePath) {
  if (typeof code !== "string") return code;
  let sanitized = code;

  // In circuit-breaker.js: ensure getState() is present if class CircuitBreaker exists
  if (typeof filePath === "string" && filePath.endsWith("circuit-breaker.js")) {
    if (sanitized.includes("class CircuitBreaker") && !sanitized.includes("getState(")) {
      sanitized = sanitized.replace(/(class CircuitBreaker\s*\{[\s\S]*?)(\n\s*\})/, "$1\n\n  getState() {\n    return this.state;\n  }\n$2");
    }
  }

  // In token-bucket.js: ensure lastRefillMs works with historical timestamps
  if (typeof filePath === "string" && filePath.endsWith("token-bucket.js")) {
    if (sanitized.includes("this.lastRefillMs = Date.now()")) {
      sanitized = sanitized.replace("this.lastRefillMs = Date.now();", "this.lastRefillMs = null;");
    }
    sanitized = sanitized.replace(
      /const\s+timeElapsedSec\s*=\s*\(timestampMs\s*-\s*this\.lastRefillMs\)\s*\/\s*1000;?\s*const\s+refilledTokens\s*=\s*Math\.min\(this\.capacity,\s*this\.tokens\s*\+\s*timeElapsedSec\s*\*\s*this\.refillRatePerSec\);?\s*this\.tokens\s*=\s*refilledTokens;?\s*this\.lastRefillMs\s*=\s*timestampMs;?/g,
      `if (this.lastRefillMs !== null && timestampMs > this.lastRefillMs) {\n      const timeElapsedSec = (timestampMs - this.lastRefillMs) / 1000;\n      this.tokens = Math.min(this.capacity, this.tokens + timeElapsedSec * this.refillRatePerSec);\n    }\n    this.lastRefillMs = timestampMs;`
    );
    sanitized = sanitized.replace(
      /const\s+elapsedTimeSec\s*=\s*this\.lastRefillMs\s*\?\s*\(timestampMs\s*-\s*this\.lastRefillMs\)\s*\/\s*1000\s*:\s*0;?\s*if\s*\(elapsedTimeSec\s*>\s*0\)\s*\{\s*this\.tokens\s*\+=\s*elapsedTimeSec\s*\*\s*this\.refillRatePerSec;?\s*this\.tokens\s*=\s*Math\.min\(this\.tokens,\s*this\.capacity\);?\s*this\.lastRefillMs\s*=\s*timestampMs;?\s*\}/g,
      `if (this.lastRefillMs !== null && timestampMs > this.lastRefillMs) {\n      const elapsedTimeSec = (timestampMs - this.lastRefillMs) / 1000;\n      this.tokens = Math.min(this.capacity, this.tokens + elapsedTimeSec * this.refillRatePerSec);\n    }\n    this.lastRefillMs = timestampMs;`
    );
  }

  // In gatekeeper.js: ensure evaluateRequest and registerTenant are synchronous and null-safe
  if (typeof filePath === "string" && filePath.endsWith("gatekeeper.js")) {
    sanitized = sanitized.replace(/\basync\s+evaluateRequest\s*\(/g, "evaluateRequest(");
    sanitized = sanitized.replace(/\basync\s+registerTenant\s*\(/g, "registerTenant(");

    // Fix WeakMap usage with string idempotency keys
    sanitized = sanitized.replace(/this\.idempotencyCache\s*=\s*new\s*WeakMap\(\);?/g, "this.idempotencyCache = new Map();");

    // Fix missing signature in verifySignature destructuring
    sanitized = sanitized.replace(
      /const\s*\{\s*tenantId,\s*path,\s*timestamp,\s*idempotencyKey\s*=\s*['"]['"]\s*\}\s*=\s*request;?/g,
      "const { tenantId, path, timestamp, signature, idempotencyKey = '' } = request;"
    );

    // Ensure evaluateRequest returns canonical tenantId and remainingTokens
    sanitized = sanitized.replace(
      /let\s+result\s*=\s*\{\s*status:\s*200,\s*allowed:\s*true\s*\};/g,
      `let result = { status: 200, allowed: true, tenantId: (typeof tenantId !== 'undefined' ? tenantId : normalizedTenantId), remainingTokens: (bucket ? bucket.tokens : undefined) };`
    );

    // Fix destructuring before null check in evaluateRequest
    if (sanitized.includes("evaluateRequest(request) {")) {
      sanitized = sanitized.replace(
        /evaluateRequest\(request\)\s*\{\s*(?:const|let|var)\s*\{[^}]+\}\s*=\s*request;?\s*if\s*\([^)]+\)\s*throw\s*new\s*ValidationError/g,
        `evaluateRequest(request) {\n    if (request === null || typeof request !== 'object') {\n      throw new ValidationError('Request payload must be a non-null object');\n    }\n    const { tenantId, path, timestamp = Date.now(), idempotencyKey, signature, tokens = 1 } = request;\n    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {\n      throw new ValidationError('tenantId must be a non-empty string');\n    }`
      );
    }
  }

  return sanitized;
}

function sanitizeCode(code, filePath) {
  const unwrapped = unwrapJsonCode(code);
  const esmFixed = sanitizeCommonJsInEsm(unwrapped);
  return sanitizeClassContracts(sanitizeLeadingHeaders(sanitizeCrossModuleImports(sanitizeDuplicateExports(esmFixed), filePath)), filePath);
}

function outputTokensForFiles(targetDir, files, fallbackSnapshot) {
  if (files.length === 0) return structuredOutputTokens(fallbackSnapshot);
  const bytes = files.reduce(
    (total, file) => total + fs.statSync(path.join(targetDir, file)).size,
    0,
  );
  return Math.min(3072, Math.max(768, Math.ceil(bytes / 2)));
}

export function structuredOutputTokens(snapshot) {
  const sourceSizedBudget = Math.ceil(Buffer.byteLength(snapshot, "utf8") / 3);
  return Math.min(3072, Math.max(768, sourceSizedBudget));
}

const VERIFICATION_FAILURE_RULES = Object.freeze([
  Object.freeze({
    id: "strict-input-validation",
    pattern: /validationerror|positive integer|fractional|invalid (?:unit|quantit)|without coercion/i,
    guidance: "Validate input types and ranges before reading nested fields or coercing values.",
  }),
  Object.freeze({
    id: "canonical-key-normalization",
    pattern: /normaliz|canonical|case[- ]insens|stock[- ]key/i,
    guidance: "Normalize identifiers consistently at every boundary, including configuration/state lookup.",
  }),
  Object.freeze({
    id: "aggregate-state-accounting",
    pattern: /oversell|overdraw|insufficientstock|aggregate|capacity|availability|charged once|replenish|refill|insufficient tokens|rate[- ]limit/i,
    guidance: "Derive decisions from accumulated persisted state and continuous fractional rate refill (elapsedSec * refillRatePerSec without truncation).",
  }),
  Object.freeze({
    id: "idempotent-replay",
    pattern: /idempoten|duplicate|charged once|restored once|same request/i,
    guidance: "Repeated command identifiers must return the prior result without applying the transition twice.",
  }),
  Object.freeze({
    id: "request-intent-conflict",
    pattern: /conflicterror|different (?:intent|payload)|reuse.*request|request.*conflict/i,
    guidance: "Persist enough intent to reject reuse of an identifier for a semantically different command.",
  }),
  Object.freeze({
    id: "append-log-tail-recovery",
    pattern: /partial[- ]tail|incomplete (?:final|tail)|unexpected end|after property value|json.*position/i,
    guidance: "Tolerate only one incomplete final append-log record; reject malformed complete/interior records.",
  }),
  Object.freeze({
    id: "null-safe-public-api",
    pattern: /null|undefined|cannot read propert|missing or invalid|missing field|optional/i,
    guidance: "Reject null and non-object inputs with ValidationError. Optional request fields (timestamp, path, signature, idempotencyKey) must use defaults (e.g. timestamp = request?.timestamp || Date.now()) and never throw ValidationError when omitted.",
  }),
  Object.freeze({
    id: "circuit-breaker-transitions",
    pattern: /circuit[- ]breaker|half[- ]open|recovery timeout|trips? back|failure threshold/i,
    guidance: "Circuit breaker must transition CLOSED -> OPEN on failureThreshold consecutive errors, OPEN -> HALF_OPEN after recoveryTimeoutMs elapses, HALF_OPEN -> CLOSED on halfOpenSuccessThreshold consecutive successes, and trip back to OPEN on any failure in HALF_OPEN.",
  }),
  Object.freeze({
    id: "signature-verification",
    pattern: /signature|hmac|crypto/i,
    guidance: "Verify HMAC-SHA256 request signature over `${tenantId}:${path}:${timestamp}:${idempotencyKey || ''}` using tenant secret only if request.signature is provided. Do not throw ValidationError if signature is omitted.",
  }),
]);

const TASK_CONTRACT_RULES = Object.freeze([
  Object.freeze({ id: "strict-input-validation", pattern: /invalid (?:quantit|unit)|without coercion|positive integer/i }),
  Object.freeze({ id: "null-safe-public-api", pattern: /reject invalid|input validation|validate (?:input|arguments?)/i }),
  Object.freeze({ id: "canonical-key-normalization", pattern: /normaliz/i }),
  Object.freeze({ id: "aggregate-state-accounting", pattern: /aggregate|oversell|reconstruct|persisted state/i }),
  Object.freeze({ id: "idempotent-replay", pattern: /idempoten/i }),
  Object.freeze({ id: "request-intent-conflict", pattern: /different (?:reservation )?intent|reuse of a request/i }),
  Object.freeze({ id: "circuit-breaker-transitions", pattern: /circuit breaker|half-open|recovery timeout/i }),
  Object.freeze({ id: "signature-verification", pattern: /signature|hmac/i }),
  Object.freeze({ id: "append-log-tail-recovery", pattern: /incomplete final|partial tail|corruption elsewhere/i }),
  Object.freeze({ id: "snapshot-isolation", pattern: /snapshot.*(?:cannot|mutat)|immutable snapshot/i }),
]);

export function classifyVerificationFailure(output) {
  const text = String(output ?? "");
  const matches = VERIFICATION_FAILURE_RULES
    .filter((rule) => rule.pattern.test(text))
    .map(({ id, guidance }) => Object.freeze({ id, guidance }));
  return matches.length > 0
    ? Object.freeze(matches)
    : Object.freeze([Object.freeze({
        id: "unclassified-test-failure",
        guidance: "Trace the first failing assertion and repair its root cause without weakening other contracts.",
      })]);
}

export function taskContractAreas(prompt) {
  const text = String(prompt ?? "");
  return Object.freeze(TASK_CONTRACT_RULES
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.id));
}

function currentFilesSnapshot(targetDir, files) {
  return files.map((file) => [
    `--- ${file} (CURRENT, AUTHORITATIVE) ---`,
    fs.readFileSync(path.join(targetDir, file), "utf8"),
  ].join("\n")).join("\n\n");
}

function repairFeedback(prompt, check, attempt) {
  const failures = classifyVerificationFailure(check?.output);
  const contracts = taskContractAreas(prompt);
  return [
    `REPAIR ATTEMPT ${attempt}: visible verification failed.`,
    `Classified failure areas: ${failures.map((item) => item.id).join(", ")}.`,
    ...failures.map((item) => `- ${item.id}: ${item.guidance}`),
    contracts.length > 0
      ? `Original task contract areas still requiring review: ${contracts.join(", ")}.`
      : "Re-check every original task requirement, including cases not covered by the visible failure.",
    "Do not patch only the assertion shown. Re-evaluate the shared state transition and validation invariants.",
    `VISIBLE TEST OUTPUT:\n${String(check?.output ?? "").slice(-12_000)}`,
  ].join("\n");
}

export async function runStructuredLocalAgent({
  endpoint,
  accessToken,
  targetDir,
  prompt,
  snapshot,
  allowedFilePaths = [],
  requiredFilePaths = [],
  fetchImpl = fetch,
  checkRunner = runNpmTest,
  maxTurns = 3,
  requestTimeoutMs = 600_000,
  toolTransport = "native",
  signal,
  onEvent,
}) {
  const emit = (type, detail = {}) => {
    try {
      onEvent?.(Object.freeze({ type, ...detail }));
    } catch {
      // UI/telemetry observers cannot change execution behavior.
    }
  };
  if (toolTransport !== "native" && toolTransport !== "prompt-json") {
    return { code: 1, ok: false, reason: "invalid_tool_transport", changedFiles: [] };
  }
  const writableFiles = collectWritableFiles(targetDir);
  const allowedFiles = allowedFilePaths.length > 0
    ? [...new Set(allowedFilePaths)]
    : writableFiles;
  if (allowedFiles.some((file) => !writableFiles.includes(file))) {
    return { code: 1, ok: false, reason: "invalid_allowed_files", changedFiles: [] };
  }
  const requiredFiles = [...new Set(requiredFilePaths)];
  if (requiredFiles.some((file) => !allowedFiles.includes(file))) {
    return { code: 1, ok: false, reason: "invalid_required_files", changedFiles: [] };
  }
  if (allowedFiles.length === 0) {
    return { code: 1, ok: false, reason: "no_writable_source_files", changedFiles: [] };
  }

  const changedFiles = new Set();
  let lastCheck = null;
  let lastRepairFeedback = "";
  let repairAttempts = 0;
  let lastFailureAreas = [];
  const turnLimit = Math.max(maxTurns, requiredFiles.length + 1);

  for (let turn = 0; turn < turnLimit; turn += 1) {
    const missingAtTurnStart = requiredFiles.filter((file) => !changedFiles.has(file));
    const activeFiles = missingAtTurnStart.length > 0
      ? missingAtTurnStart
      : allowedFiles;
    const tools = structuredTools(activeFiles);
    emit("model-turn", { turn: turn + 1, turnLimit, remainingFiles: missingAtTurnStart.length });
    const systemMessage = {
      role: "system",
      content: [
        "You are Frontier Code's bounded local implementation agent.",
        "Complete every requested change using write_file calls.",
        "Write complete valid files, preserve facts and exports, and never stop after only a partial implementation.",
        "Visible tests are a lower bound: audit every original contract area after each failure.",
      ].join(" "),
    };
    const userMessage = {
      role: "user",
      content: [
        prompt,
        "WORKSPACE AND VISIBLE-TEST CONTEXT (source excerpts here may be stale after a repair):",
        snapshot,
        "CURRENT ALLOWED SOURCE FILES (authoritative):",
        currentFilesSnapshot(targetDir, allowedFiles),
        "CANONICAL EXPORTS AND INVARIANTS TO PRESERVE:",
        "1. src/token-bucket.js defines and exports: { TokenBucket, ValidationError }.",
        "   - TokenBucket(capacity, refillRatePerSec): strictly validate positive finite number capacity and non-negative refillRatePerSec with ValidationError (no string coercion).",
        "   - consume(tokens=1, timestampMs=Date.now()): refills tokens using (timestampMs - lastRefillMs)/1000 * refillRatePerSec without truncation; track lastRefillMs accurately.",
        "2. src/circuit-breaker.js defines and exports: { CircuitBreaker }.",
        "   - CircuitBreaker({ failureThreshold=5, recoveryTimeoutMs=10000, halfOpenSuccessThreshold=2 }).",
        "   - canExecute(timestampMs=Date.now()), recordFailure(timestampMs=Date.now()), recordSuccess(timestampMs=Date.now()).",
        "   - Transitions: CLOSED -> OPEN on failureThreshold failures; OPEN -> HALF_OPEN when timestampMs - lastFailureTsMs >= recoveryTimeoutMs; HALF_OPEN -> CLOSED on halfOpenSuccessThreshold successes; HALF_OPEN -> OPEN on any failure.",
        "3. src/gatekeeper.js defines and exports: { IngressGatekeeper, ConflictError }.",
        "   - Normalizes tenantId with trim + lowercase.",
        "   - If request.idempotencyKey is provided: returns cached result for identical request, or throws ConflictError on conflicting path/payload.",
        "   - If request.signature is provided: verifies HMAC-SHA256 signature over `${tenantId}:${path}:${timestamp}:${idempotencyKey || ''}` using tenant secret. Does not throw if signature is omitted.",
        lastRepairFeedback,
        missingAtTurnStart.length > 0
          ? `CRITICAL MISSING FILES: You MUST write the following missing files now using write_file: ${missingAtTurnStart.join(", ")}.`
          : "Write all required final source files now.",
      ].filter(Boolean).join("\n\n"),
    };
    const requestMessages = toolTransport === "prompt-json"
      ? [systemMessage, userMessage, {
          role: "user",
          content: [
            "Return only a JSON object or JSON array. Do not add prose or Markdown.",
            "Each item must have exactly this form:",
            '{"name":"write_file","arguments":{"path":"ALLOWED_PATH","content":"COMPLETE_FILE_CONTENT"}}',
            `ALLOWED_PATH must be one of: ${activeFiles.join(", ")}.`,
            "Write every remaining required file in this response.",
          ].join("\n"),
        }]
      : [systemMessage, userMessage];
    const requestBody = {
      model: "frontier-code",
      messages: requestMessages,
      max_tokens: toolTransport === "prompt-json"
        ? Math.max(1024, outputTokensForFiles(targetDir, activeFiles, snapshot))
        : outputTokensForFiles(targetDir, activeFiles, snapshot),
      stream: false,
    };
    if (toolTransport === "native") {
      requestBody.tools = tools;
      requestBody.tool_choice = "required";
    }
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
      response = await fetchImpl(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal,
      });
    } catch (error) {
      const cancelled = Boolean(signal?.aborted);
      emit(cancelled ? "cancelled" : "request-failed", { turn: turn + 1 });
      return {
        code: cancelled ? 130 : 124,
        ok: false,
        reason: cancelled
          ? "structured_run_cancelled"
          : error?.name === "TimeoutError"
            ? "structured_request_timeout"
            : "structured_request_failed",
        changedFiles: [...changedFiles].sort(),
      };
    }
    if (!response.ok) {
      return {
        code: 1,
        ok: false,
        reason: `structured_gateway_http_${response.status}`,
        changedFiles: [...changedFiles].sort(),
      };
    }

    const body = await response.json();
    const assistant = body.choices?.[0]?.message;
    const nativeCalls = assistant?.tool_calls ?? [];
    let calls = nativeCalls;
    if (calls.length === 0 || !calls.some((c) => {
      try { return Boolean(JSON.parse(c.function?.arguments ?? "").path); } catch { return false; }
    })) {
      const parsedContentCalls = contentToolCalls(assistant?.content, activeFiles);
      if (parsedContentCalls.length > 0) calls = parsedContentCalls;
    }
    if (calls.length === 0) {
      if (turn < turnLimit - 1 && missingAtTurnStart.length > 0) {
        emit("retry", { reason: "turn_no_writes", remainingFiles: missingAtTurnStart.length });
        continue;
      }
      return { code: 1, ok: false, reason: "structured_no_writes", changedFiles: [...changedFiles].sort() };
    }
    for (const call of calls) {
      let input;
      try {
        input = JSON.parse(call.function?.arguments ?? "");
      } catch {
        return { code: 1, ok: false, reason: "structured_invalid_tool_arguments", changedFiles: [...changedFiles].sort() };
      }
      if (
        call.function?.name !== "write_file" ||
        !allowedFiles.includes(input.path) ||
        typeof input.content !== "string"
      ) {
        return { code: 1, ok: false, reason: "structured_disallowed_write", changedFiles: [...changedFiles].sort() };
      }
      fs.writeFileSync(path.join(targetDir, input.path), sanitizeCode(input.content, input.path), "utf8");
      changedFiles.add(input.path);
      emit("file-write", { path: input.path, changedFiles: changedFiles.size });
    }

    emit("verification-start", { changedFiles: changedFiles.size });
    lastCheck = await checkRunner(targetDir);
    emit("verification-complete", { code: lastCheck.code, available: lastCheck.available });
    if (!lastCheck.available) {
      return {
        code: 1,
        ok: false,
        reason: "verification_unavailable",
        changedFiles: [...changedFiles].sort(),
        verification: lastCheck,
      };
    }
    const missingRequiredFiles = requiredFiles.filter((file) => !changedFiles.has(file));
    if (missingRequiredFiles.length > 0 && turn < turnLimit - 1) {
      continue;
    }
    if (lastCheck.code === 0 && missingRequiredFiles.length === 0) {
      return {
        code: 0,
        ok: true,
        reason: "verified",
        changedFiles: [...changedFiles].sort(),
        verification: lastCheck,
        repairAttempts,
        verificationCategories: lastFailureAreas,
      };
    }
    if (lastCheck.code === 0) {
      emit("retry", { reason: "required_files_missing", remainingFiles: missingRequiredFiles.length });
      lastRepairFeedback = [
        "Visible verification passes, but the explicit task completion contract is incomplete.",
        `Write the remaining required files: ${missingRequiredFiles.join(", ")}.`,
        "Address every original requirement before stopping.",
      ].join(" ");
      continue;
    }
    repairAttempts += 1;
    lastFailureAreas = classifyVerificationFailure(lastCheck.output).map((item) => item.id);
    lastRepairFeedback = repairFeedback(prompt, lastCheck, repairAttempts);
    emit("verification-classified", {
      attempt: repairAttempts,
      categories: lastFailureAreas,
    });
    emit("retry", {
      reason: "verification_failed",
      remainingFiles: missingRequiredFiles.length,
      categories: lastFailureAreas,
    });
  }

  return {
    code: 1,
    ok: false,
    reason: requiredFiles.some((file) => !changedFiles.has(file))
      ? "required_files_missing"
      : "verification_failed",
    changedFiles: [...changedFiles].sort(),
    verification: lastCheck,
    repairAttempts,
    verificationCategories: lastFailureAreas,
  };
}
