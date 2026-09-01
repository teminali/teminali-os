# Benchmark 004: Multi-File State Refactor (TypeScript + Zustand Migration)

## Objective
Refactor a legacy React Context state store spread across 4 interrelated files into modular Zustand slices with zero circular dependencies and 100% strict TypeScript types.

## Invariant Rules
1. Zero TypeScript compilation errors (`tsc --noEmit` must pass).
2. All unit tests must pass with 0 regressions.
3. Surgical diffs only (+lines / -lines minimized).
