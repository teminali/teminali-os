---
name: teminali-cut-copilot
description: Direct AI video editing and Copilot integration for Teminali Cut. Use when editing video timelines, splitting clips, adding effects, text, captions, beat detection, transitions, grading, audio processing, or exporting video in Teminali Cut over MCP without requiring external CLI API keys or subscriptions.
---

# Teminali Cut Video Copilot Skill

Control the running Teminali Cut desktop video editor directly via MCP tools.

## Architecture

Teminali Cut runs a local JSON-RPC bridge on `http://127.0.0.1:3888/rpc` guarded by a session token, exposed via `dist-electron/mcpStdio.cjs`. All edits are executed live on the user's active timeline.

## Primary Workflow

1. **Understand Timeline State**:
   - Call `mcp_teminali_cut_describe_timeline` to get all tracks, clips, IDs, timings, and canvas dimensions.
   - Call `mcp_teminali_cut_get_frame_context` to inspect visible layers and canvas bounds at the current playhead.

2. **Execute Edits**:
   - **Clips**: `mcp_teminali_cut_insert_clip`, `mcp_teminali_cut_split_clip`, `mcp_teminali_cut_trim_clip`, `mcp_teminali_cut_move_clip`, `mcp_teminali_cut_delete_clip`.
   - **Properties & Styling**: `mcp_teminali_cut_patch_clip` or `mcp_teminali_cut_patch_clips`.
   - **Text & Captions**: `mcp_teminali_cut_add_text_layer`, `mcp_teminali_cut_add_kinetic_caption`.
   - **VFX & Looks**: `mcp_teminali_cut_list_effects`, `mcp_teminali_cut_add_effect`, `mcp_teminali_cut_apply_look_preset`.
   - **Audio & Beats**: `mcp_teminali_cut_detect_beats`, `mcp_teminali_cut_snap_cuts_to_beats`, `mcp_teminali_cut_transcribe_audio`.
   - **Export**: `mcp_teminali_cut_render_export` (supports H.264, HEVC, ProRes, 1080p/2K/4K).

3. **Verify Canvas**:
   - Call `mcp_teminali_cut_get_frame_context` or `mcp_teminali_cut_describe_timeline` to confirm changes on the live canvas.
