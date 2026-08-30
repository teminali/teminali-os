---
name: frontiercut-copilot
description: Direct AI video editing and Copilot integration for FrontierCut. Use when editing video timelines, splitting clips, adding effects, text, captions, beat detection, transitions, grading, audio processing, or exporting video in FrontierCut over MCP without requiring external CLI API keys or subscriptions.
---

# FrontierCut Video Copilot Skill

Control the running FrontierCut desktop video editor directly via MCP tools.

## Architecture

FrontierCut runs a local JSON-RPC bridge on `http://127.0.0.1:3888/rpc` guarded by a session token, exposed via `dist-electron/mcpStdio.cjs`. All edits are executed live on the user's active timeline.

## Primary Workflow

1. **Understand Timeline State**:
   - Call `mcp_kerf_describe_timeline` to get all tracks, clips, IDs, timings, and canvas dimensions.
   - Call `mcp_kerf_get_frame_context` to inspect visible layers and canvas bounds at the current playhead.

2. **Execute Edits**:
   - **Clips**: `mcp_kerf_insert_clip`, `mcp_kerf_split_clip`, `mcp_kerf_trim_clip`, `mcp_kerf_move_clip`, `mcp_kerf_delete_clip`.
   - **Properties & Styling**: `mcp_kerf_patch_clip` or `mcp_kerf_patch_clips` (e.g. `filters.saturation`, `transform.rotation`, `textStyle.color`).
   - **Text & Captions**: `mcp_kerf_add_text_layer`, `mcp_kerf_add_kinetic_caption`.
   - **VFX & Looks**: `mcp_kerf_list_effects`, `mcp_kerf_add_effect`, `mcp_kerf_apply_look_preset`.
   - **Audio & Beats**: `mcp_kerf_detect_beats`, `mcp_kerf_snap_cuts_to_beats`, `mcp_kerf_transcribe_audio`.
   - **Export**: `mcp_kerf_render_export` (supports H.264, HEVC, ProRes, 1080p/2K/4K).

3. **Verify Canvas**:
   - Call `mcp_kerf_get_frame_context` or `mcp_kerf_describe_timeline` to confirm changes on the live canvas.
