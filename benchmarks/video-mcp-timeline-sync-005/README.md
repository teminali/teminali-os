# Benchmark 005: Video MCP Timeline Sync & Silence Ripping

## Objective
Execute MCP tool `frontiercut_split_silence` on audio track A1, remove 4 dead pauses, snap cut points to 120 BPM downbeats, and verify 4K export readiness.

## Invariant Rules
1. MCP port 3888 must respond with status `completed`.
2. Exact time saved must equal 3.4 seconds.
3. Timeline sync timestamp must match audio waveform peak.
