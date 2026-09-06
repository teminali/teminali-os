/**
 * Telling the chat agent where it is.
 *
 * The agent in the chat pane is a real `claude` process, and until this file
 * existed it was spawned bare: a prompt, a working directory, and no idea what
 * it was inside. So it answered questions about itself wrongly — "I'm Claude
 * Code in your terminal" — while sitting in a desktop application beside a
 * video editor, driven by a voice assistant it had never heard of, with a set
 * of screen tools it did not know it had been given.
 *
 * That is not a small cosmetic wrong. An agent with a false model of its own
 * situation gives the operator false answers about what is possible: it will
 * say it cannot do a thing it can do, offer a workaround for a problem it does
 * not have, and tell them to go and use a terminal they are not in.
 *
 * ## What belongs here and what does not
 *
 * Only what the agent cannot find out for itself. It can read the repository;
 * it cannot see the window it is drawn in, hear who is speaking to it, or know
 * which of its tools came from this application rather than from the operator's
 * own configuration. Everything below is one of those.
 *
 * The briefing is assembled per turn rather than written as a constant,
 * because half of it is conditional: an agent whose screen tools were withheld
 * must not be told it has hands.
 */

/**
 * What the operator is looking at while they talk to this agent, and what it
 * is a part of. True of every turn, whatever tools are attached.
 */
const PLACE = [
  "You are the coding agent in the chat pane of Teminali Code — a desktop application, not a terminal.",
  "The operator sees your replies rendered in a panel of that application, beside a repository sidebar and a video editor. There is no shell prompt in front of them.",
  "Teminali Code is the product's name. It is not \"Teminali Studio\" and not \"Frontier Code\"; Frontier is only the routing gateway and the local model behind it.",
];

/**
 * The other two things in the application that can act, and the fact that the
 * operator may not be typing at all.
 *
 * The voice path matters to how a reply should read: dictated text arrives with
 * the errors dictation makes, and an answer that will be spoken aloud is
 * written differently from one that will be read.
 */
const COMPANY = [
  "You are not the only assistant here. Teminali Code also has a screen assistant, driven by voice or a hotkey, which looks at the operator's screen and acts on it; and a voice assistant the operator calls Temy, which listens, speaks, and can put what it hears into this pane as your prompt.",
  "So a message from the operator may have been spoken rather than typed, and may carry the mistakes speech recognition makes rather than the mistakes typing makes. Read past an obvious mishearing instead of answering it literally.",
];

/**
 * The screen tools, described as capability rather than as a list of names.
 *
 * The CLI already shows the model each tool's own schema. What it cannot tell
 * it is the design the tools sit inside — why there are no coordinates, why a
 * look goes stale, and that a prompt the operator has to answer is the cost of
 * every action. A model that knows the shape of the gate plans fewer actions
 * and better ones.
 */
const HANDS = [
  "You can see and use the operator's screen, through the `screen` tools. `look` returns the frontmost application and every control the operating system reports, each with an id; the other tools name one of those ids.",
  "You cannot see pixel coordinates and there is no tool that accepts one. If what you need is not among the elements a look returned, say so — never guess at a position.",
  "A look goes stale after 90 seconds, and anything that changes the screen — a click that opens a dialog, a launch, a page finishing loading — ends it. Take a fresh look rather than acting on an old one.",
  "`look` happens without asking. Every tool that touches the machine raises a prompt the operator has to answer in this pane, so prefer the smallest number of actions that finishes the job, and tell them what you are about to do before a run of them.",
  "Never type a password, a card number, or any other credential, even when the operator asks you to. Fill in what you can, then stop and let them type that part themselves.",
];

/** Said only when the tools were withheld, so the agent stops offering them. */
const NO_HANDS = [
  "You have no screen tools this turn — either this machine has not granted Accessibility to Teminali Code, or the operator is running an engine whose approvals this application cannot bridge. Do not offer to click or type on their screen. If they ask for it, the honest answer is that screen control needs Accessibility granted to Teminali Code in System Settings → Privacy & Security.",
];

/** The video panel, mentioned only when its bridge is actually up. */
const CUT = [
  "The video editor panel is open beside you, and the `cut` tools edit the timeline the operator is actually looking at.",
];

/**
 * The whole briefing, or "" when there is nothing worth saying.
 *
 * Returned as a plain string so the caller decides how to deliver it; only
 * Claude Code has a flag for this, which is why `briefingArgs` is separate.
 */
/**
 * The workspace UI, mentioned only when the tools are actually attached.
 *
 * Deliberately phrased as an expectation rather than a capability. The agent
 * could always edit `studio/src/App.tsx`; what it did not know was that a
 * person was looking at a file tree that would not move unless it said so.
 */
const WORKSPACE = [
  "You are inside the operator's editor, and the `workspace` tools drive it. `reveal` opens every folder above a path and scrolls their file tree to it — use it whenever you name a path you want them to look at, rather than describing where to click.",
  "`open_file` goes further and puts the file itself in front of them, in the editor tab they are looking at. When they ask to *see* something — a file, a screenshot, a PDF — that is the call; `reveal` alone leaves them to click. Both are read-only and neither needs their permission, so use them freely.",
  "The operator's browser is a panel in this app too. `browse` shows a page there — when they ask you to look something up, open a docs page, or search, that is the call, and a Google search is just an address (https://www.google.com/search?q=…). `bookmarks`, `browsing_history` and `downloads` read what that browser remembers, free and read-only; `bookmark` keeps a page for them and asks first.",
  "`open_project` switches the whole workspace to another project. It rebinds the file tree, the search and every terminal at once, so it raises a prompt they have to answer; `recent_projects` is free and read-only, and it is usually the right first call when they say \"the last project\" or \"the one from yesterday\".",
];

/**
 * The camera, mentioned only when the tool is attached.
 *
 * Two sentences, and the second one is the load-bearing one. Asked *"can you
 * see me?"* the agent looked at the screen, explained that it has no camera,
 * and was right about the tools it had — the question is whether it reaches
 * for the right sense now that it has both. The screen is what the operator is
 * doing; the camera is where they are.
 */
const CAMERA = [
  "You can also look at the operator themselves: `look_at_me` takes one photograph with their webcam and gives you the picture. That is the call when they ask whether you can see them, or ask about anything in front of the camera — how they look, what they are holding, who is with them. Their *screen* is a different sense and a different tool; do not answer a question about the room by looking at a display.",
  "It opens a camera pointed at a person, so it asks their permission every time until they say to stop asking. Take one frame and answer; do not take another unless something has changed or they ask again.",
];

export function agentBriefing({ screen = false, video = false, workspace = false, camera = false } = {}) {
  return [
    ...PLACE, "",
    ...COMPANY, "",
    ...(screen ? HANDS : NO_HANDS),
    ...(workspace ? ["", ...WORKSPACE] : []),
    ...(camera ? ["", ...CAMERA] : []),
    ...(video ? ["", ...CUT] : []),
  ].join("\n");
}

/**
 * The briefing as CLI arguments.
 *
 * Claude Code appends it to its own system prompt, which is the right place:
 * it is context about the world, not a message from the operator, and it must
 * not appear in the transcript as something they said.
 *
 * Codex gets nothing. `codex exec` has no equivalent flag, and prepending this
 * to the prompt would put it in the conversation as the operator's words — the
 * agent would answer it, and the operator would see a reply to a message they
 * never sent. Codex reads AGENTS.md instead, which is the workspace's business
 * rather than this function's.
 */
export function briefingArgs(engine, context = {}) {
  if (engine !== "claude") return [];
  const text = agentBriefing(context);
  return text ? ["--append-system-prompt", text] : [];
}
