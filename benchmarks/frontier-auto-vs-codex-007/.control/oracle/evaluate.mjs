import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function evaluate(workspace) {
  let tokenBucketModule;
  let circuitBreakerModule;
  let gatekeeperModule;

  try {
    const tbPath = pathToFileURL(path.resolve(workspace, 'src', 'token-bucket.js')).href;
    const cbPath = pathToFileURL(path.resolve(workspace, 'src', 'circuit-breaker.js')).href;
    const gkPath = pathToFileURL(path.resolve(workspace, 'src', 'gatekeeper.js')).href;
    tokenBucketModule = await import(`${tbPath}?t=${Date.now()}`);
    circuitBreakerModule = await import(`${cbPath}?t=${Date.now()}`);
    gatekeeperModule = await import(`${gkPath}?t=${Date.now()}`);
  } catch (error) {
    return { score: 0, maxScore: 100, loadError: String(error), checks: [] };
  }

  const { TokenBucket, ValidationError } = tokenBucketModule;
  const { CircuitBreaker } = circuitBreakerModule;
  const { IngressGatekeeper, ConflictError } = gatekeeperModule;

  const checks = [];
  async function check(id, points, run) {
    try {
      await run();
      checks.push({ id, points, earned: points, passed: true });
    } catch (error) {
      checks.push({ id, points, earned: 0, passed: false, error: `${error?.name || 'Error'}: ${error?.message || error}` });
    }
  }

  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const assertThrows = (run, checkName) => {
    try {
      run();
    } catch (error) {
      if (!checkName || error?.name === checkName || /validation|conflict/i.test(error?.name || '')) return;
      throw error;
    }
    throw new Error(`expected ${checkName || 'an error'}`);
  };

  // 1. Strict Input Validation (15 pts)
  await check('validation-errors', 15, () => {
    assertThrows(() => new TokenBucket(-1, 1), 'ValidationError');
    assertThrows(() => new TokenBucket(0, 1), 'ValidationError');
    assertThrows(() => new TokenBucket("10", 1), 'ValidationError');
    assertThrows(() => new TokenBucket(10, -0.5), 'ValidationError');
    const b = new TokenBucket(5, 1);
    assertThrows(() => b.consume(-1), 'ValidationError');
    assertThrows(() => b.consume("1"), 'ValidationError');
    const gk = new IngressGatekeeper();
    assertThrows(() => gk.registerTenant("", { secret: "sec" }), 'ValidationError');
    assertThrows(() => gk.evaluateRequest(null), 'ValidationError');
  });

  // 2. Canonical Key Normalization (15 pts)
  await check('canonical-normalization', 15, () => {
    const gk = new IngressGatekeeper();
    gk.registerTenant("  Alpha_Tenant  ", { secret: "secret-alpha", capacity: 10, refillRatePerSec: 1 });
    const req1 = gk.evaluateRequest({ tenantId: "alpha_tenant", path: "/api/v1/test", timestamp: 1000 });
    assert(req1?.status === 200, 'lowercase lookup must match registered tenant');
    const req2 = gk.evaluateRequest({ tenantId: "  ALPHA_TENANT  ", path: "/api/v1/test", timestamp: 1000 });
    assert(req2?.status === 200, 'uppercase spaced lookup must match');
    assert(req2?.tenantId === 'alpha_tenant', 'canonicalized tenant id');
  });

  // 3. Token Bucket Rate Limiting (15 pts)
  await check('token-bucket-replenish', 15, () => {
    const bucket = new TokenBucket(4, 2);
    const t0 = 1000000;
    const c1 = bucket.consume(3, t0);
    assert(c1.allowed === true && c1.remainingTokens === 1, 'initial consumption');
    const c2 = bucket.consume(2, t0);
    assert(c2.allowed === false && c2.retryAfterSec === 0.5, 'insufficient tokens');
    const c3 = bucket.consume(4, t0 + 1500);
    assert(c3.allowed === true && c3.remainingTokens === 0, 'time refill consumption');
    const c4 = bucket.consume(1, t0 + 11500);
    assert(c4.allowed === true && c4.remainingTokens === 3, 'capacity ceiling');
  });

  // 4. Circuit Breaker State Transitions (15 pts)
  await check('circuit-breaker-transitions', 15, () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 5000, halfOpenSuccessThreshold: 2 });
    const t0 = 1000000;
    assert(cb.getState() === 'CLOSED', 'initially CLOSED');
    cb.recordFailure(t0);
    cb.recordFailure(t0);
    assert(cb.getState() === 'CLOSED', 'under threshold remains CLOSED');
    cb.recordFailure(t0);
    assert(cb.getState() === 'OPEN', '3rd failure trips to OPEN');
    assert(cb.canExecute(t0 + 1000) === false, 'cannot execute during OPEN');
    assert(cb.canExecute(t0 + 5001) === true, 'recovery timeout transitions to HALF_OPEN');
    assert(cb.getState() === 'HALF_OPEN', 'state is HALF_OPEN');
    cb.recordSuccess();
    assert(cb.getState() === 'HALF_OPEN', '1st success in HALF_OPEN');
    cb.recordSuccess();
    assert(cb.getState() === 'CLOSED', '2nd success restores CLOSED');
    cb.recordFailure(t0 + 6000);
    cb.recordFailure(t0 + 6000);
    cb.recordFailure(t0 + 6000);
    assert(cb.canExecute(t0 + 12000) === true, 're-enters HALF_OPEN');
    cb.recordFailure(t0 + 12001);
    assert(cb.getState() === 'OPEN', 'failure in HALF_OPEN trips to OPEN immediately');
  });

  // 5. Idempotent Replay (15 pts)
  await check('idempotent-replay', 15, () => {
    const gk = new IngressGatekeeper();
    gk.registerTenant('tenant-beta', { secret: 'beta-sec', capacity: 2, refillRatePerSec: 0 });
    const req = { tenantId: 'tenant-beta', path: '/payments/charge', timestamp: 1000, idempotencyKey: 'idem-req-001', tokens: 1 };
    const res1 = gk.evaluateRequest(req);
    assert(res1?.status === 200 && res1?.remainingTokens === 1, 'turn 1 initial charge');
    const res2 = gk.evaluateRequest(req);
    assert(res2?.status === 200 && res2?.idempotentReplay === true, 'turn 2 cached replay');
    const res3 = gk.evaluateRequest({ ...req, idempotencyKey: 'idem-req-002' });
    assert(res3?.status === 200 && res3?.remainingTokens === 0, '2nd token consumed by new key');
  });

  // 6. Request Intent Conflict (15 pts)
  await check('intent-conflict', 15, () => {
    const gk = new IngressGatekeeper();
    gk.registerTenant('tenant-gamma', { secret: 'gamma-sec', capacity: 10 });
    gk.registerTenant('tenant-delta', { secret: 'delta-sec', capacity: 10 });
    gk.evaluateRequest({ tenantId: 'tenant-gamma', path: '/orders/create', timestamp: 1000, idempotencyKey: 'idem-order-999' });
    assertThrows(() => {
      gk.evaluateRequest({ tenantId: 'tenant-gamma', path: '/orders/cancel', timestamp: 1000, idempotencyKey: 'idem-order-999' });
    }, 'ConflictError');
    assertThrows(() => {
      gk.evaluateRequest({ tenantId: 'tenant-delta', path: '/orders/create', timestamp: 1000, idempotencyKey: 'idem-order-999' });
    }, 'ConflictError');
  });

  // 7. Signature Verification (10 pts)
  await check('signature-verification', 10, () => {
    const gk = new IngressGatekeeper();
    const secret = 'secret-key-777';
    gk.registerTenant('tenant-secure', { secret, capacity: 5, refillRatePerSec: 1 });
    const pathUrl = '/api/v2/secure-resource';
    const timestamp = 1700000000000;
    const idempotencyKey = 'key-sec-1';
    const canonical = `tenant-secure:${pathUrl}:${timestamp}:${idempotencyKey}`;
    const validSignature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    const resValid = gk.evaluateRequest({ tenantId: 'tenant-secure', path: pathUrl, timestamp, idempotencyKey, signature: validSignature });
    assert(resValid?.status === 200, 'valid signature accepted');
    const resInvalid = gk.evaluateRequest({ tenantId: 'tenant-secure', path: pathUrl, timestamp, idempotencyKey: 'key-sec-2', signature: validSignature });
    assert(resInvalid?.status === 401 && resInvalid?.reason === 'INVALID_SIGNATURE', 'mismatched signature rejected with 401');
  });

  const totalScore = checks.reduce((sum, c) => sum + c.earned, 0);
  return {
    score: totalScore,
    maxScore: 100,
    checks,
  };
}
