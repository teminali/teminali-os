# Benchmark 007 Scoring Rubric (100 Points Total)

| Category | Points | Description |
|---|:---:|---|
| **1. Strict Input Validation** | 15 | Null, undefined, and non-numeric inputs throw `ValidationError`; no coercion. |
| **2. Canonical Key Normalization** | 15 | Trimming and lowercasing across tenant registration, bucket lookup, and routing. |
| **3. Token Bucket Rate Limiter** | 15 | Elapsed-time mathematical token refill, bounded capacity, retry-after calculations. |
| **4. Circuit Breaker State Machine** | 15 | Accurate CLOSED -> OPEN -> HALF_OPEN -> CLOSED transitions with thresholds. |
| **5. Idempotent Replay** | 15 | Replaying same idempotency key returns identical cached result without deducting tokens. |
| **6. Request Intent Conflict** | 15 | Reusing idempotency key for differing payload throws `ConflictError`. |
| **7. Signature Verification & End-to-End** | 10 | HMAC-SHA256 signature verification over canonical payload string. |
| **Total** | **100** | Full private oracle test suite. |
