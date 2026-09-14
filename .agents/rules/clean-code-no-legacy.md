# Rule: Zero Legacy Code & Ruthless Pruning

## Core Mandate
Always delete legacy and superseded implementation code. Never leave dead, deprecated, obsolete, or duplicate implementations lingering in the codebase.

## 1. Ruthless Legacy Deletion
- **No Dead Parallel Paths**: When introducing an improved or unified engine (e.g., fast paths, compound runners, telemetry retrievers), completely remove the superseded functions and routes.
- **No Commented-Out Code**: Do not leave commented-out blocks or `// deprecated - kept for reference` blocks. Git tracks history; active files must only contain active, production code.
- **Single Source of Truth**: Never maintain two parallel dispatchers or parsers doing the same thing in different files. Unify them into a single, shared module and delete the redundant copies.

## 2. Lean, Readable & Scalable Architecture
- Optimize for high capability with minimal code footprint.
- Code must be instantly legible and understandable by human developers and AI assistants.
- If an abstraction no longer serves a purpose or can be collapsed into a cleaner pattern, refactor and prune it immediately.
