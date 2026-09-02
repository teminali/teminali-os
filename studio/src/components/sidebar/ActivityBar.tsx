import { Boxes, Files, MessagesSquare, Search, SlidersHorizontal, SquarePen, type LucideIcon } from "lucide-react";

/**
 * What the sidebar can show, and how each view names itself.
 *
 * This file used to draw a 48px icon rail down the left edge. Cursor's agent
 * window has no rail: one sidebar holds the traffic lights, the nav rows and
 * the chat list, flush against the window edge, and a nav row *is* the view
 * switch. The rail is gone; these definitions are what survived it, and they
 * are now consumed as rows by `Sidebar` rather than as tabs by a rail.
 *
 * The split below is the reason this is a list of two groups rather than one.
 * `PRIMARY_NAV` is Cursor's own four rows, in Cursor's order — that block is a
 * fixed reproduction and nothing should be added to it. `WORKSPACE_NAV` holds
 * the three views this studio has that Cursor's agent window does not. Keeping
 * them below a section label means the top of the sidebar still reads exactly
 * like the reference, and the extras arrive in the same visual grammar instead
 * of diluting it.
 */

export type SidebarTabId = "chats" | "files" | "search" | "skills";

export interface SidebarTabDef {
  id: SidebarTabId;
  label: string;
  shortcut?: string;
  icon: LucideIcon;
}

/**
 * Cursor's primary rows, minus the ones this studio has no feature behind.
 *
 * Cursor's set includes "Automations". It is not here because nothing in this
 * app schedules recurring work, and a nav row that highlights itself and shows
 * nothing is worse than an absent one — it teaches the operator that rows in
 * this list might not do anything. Add it back the day there is an automations
 * view to open. Do not extend this list for anything else; see WORKSPACE_NAV.
 */
export const PRIMARY_NAV = [
  { id: "new-chat", label: "New Chat", icon: SquarePen },
  { id: "search", label: "Search", icon: Search },
  { id: "customize", label: "Customize", icon: SlidersHorizontal },
] as const;

export type PrimaryNavId = (typeof PRIMARY_NAV)[number]["id"];

/** This studio's own views, under their own label. */
export const WORKSPACE_NAV: readonly SidebarTabDef[] = [
  { id: "files", label: "Explorer", shortcut: "⇧⌘E", icon: Files },
  { id: "skills", label: "Skills", icon: Boxes },
] as const;

/** Every view the sidebar can host, for callers that need the whole set. */
export const SIDEBAR_TABS: readonly SidebarTabDef[] = [
  { id: "chats", label: "Chats", shortcut: "⌘L", icon: MessagesSquare },
  { id: "search", label: "Search", shortcut: "⇧⌘F", icon: Search },
  ...WORKSPACE_NAV,
] as const;
