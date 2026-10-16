# Kanbot

A global kanban board inside Claude Code that hands queued cards to background Claude agents across your projects. It runs in the Code tab of the Claude desktop app and in the terminal.

- **Projects** point at a git repo (cards get their own branch and worktree, and are merged when you mark them Done) or a plain folder (a "chat" project: cards run one at a time, no git).
- **Cards** move Backlog → Queued → Running → Review → Done. You move cards into Queued and Done; Kanbot moves the rest.
- **One dispatcher session** starts queued cards as background agents in each card's folder, tracks their progress, and runs the merge when you mark a card Done.

## Requirements

- Claude Code 2.1.287 or later (mods are on by default from that version). Check with `claude --version`.
- Mods allowed on the machine. On a managed work machine, run `/plugin` in a session first: if your organization only allows managed mods, user-installed mods like this one will not load.

## Install

From GitHub:

```bash
claude plugin marketplace add roboza/kanbot
claude plugin install kanbot@kanbot-local
```

Or from a local copy: unzip or clone this folder somewhere you keep it, for example `~/claude-mods/kanbot`. Then, in a terminal:

```bash
claude plugin marketplace add ~/claude-mods/kanbot
claude plugin install kanbot@kanbot-local
```

Kanbot is then active in new sessions, including the Code tab of the desktop app. Because the marketplace is a local folder, edits to the folder take effect after `/reload-plugins`.

To try it without installing, start the terminal with `claude --plugin-dir ~/claude-mods/kanbot`.

## Getting started

1. **Open the board.** In any Code-tab session, run `/kanbot`. The board opens in a side pane.
2. **Add your projects.** Open the Projects tab (`p`). For each project, enter a name, pick Repo or Chat, give the absolute folder, and for repos the base branch, how many cards may run at once, and an optional test command to run after merging. Kanbot checks the folder and branch before saving.
3. **Start a dispatcher.** Open a Code-tab session in a folder that contains all your projects (for example `~/work`), set its permission mode to one that allows edits (accept edits, or auto), and run `/kanbot work`. Keep this session open: it runs the agents. Agents inherit its permission mode; a tool they are refused flags the card as waiting on you.
4. **Add cards.** Type in the New card field (`<title> | <brief>`, or `<project>: <title> | <brief>` when showing all projects), or run `/kanbot add`. Click a card to open it: edit the brief, add acceptance checks, and choose sequential or parallel.
5. **Queue work.** Drag cards from Backlog to Queued, ordered top to bottom. Kanbot starts them as room allows.
6. **Review.** When a card reaches Review, open it to read Claude's summary. Then drag it to Done (or press Done) to merge it, send it back with a note, or discard the work.

## How cards run

- Each project's queue drains top to bottom. A **sequential** card waits until nothing else of its project runs and holds the cards under it. A **parallel** card starts while the project's limit allows. Chat projects always run one card at a time.
- All projects run side by side, up to a global limit (4 by default; change it in the Projects tab).
- A repo card runs in its own git worktree on branch `kanbot/<card id>`, at `<parent of repo>/.kanbot-worktrees/<repo>/<card id>`. Your main checkout is not touched while it works.
- **Done** on a repo card starts a merge agent in the repo's main folder. It stops if the checkout has uncommitted changes or is not on the base branch, merges with `--no-ff`, runs the test command if you set one, and undoes the merge if the tests fail. Kanbot then checks the branch really landed before moving the card to Done and removing the worktree and branch. Nothing is pushed.
- If an agent disappears (for example, the dispatcher session was closed), the card returns to the top of Queued and starts again.

## Commands

| Command | Does |
| --- | --- |
| `/kanbot` | Open the board |
| `/kanbot add <title>` | Add a card; also `<project>: <title> \| <brief>` |
| `/kanbot work` | Make this session the dispatcher (`work force` takes over from another) |
| `/kanbot pause` / `resume` | Stop or restart starting new cards |
| `/kanbot stop` | Stop dispatching from this session |
| `/kanbot projects` | Open the Projects tab |

Pane keys: `b` Board, `c` Card, `p` Projects, `a` Activity.

## Where data lives

Everything is in Kanbot's own store under `~/.claude/plugins/store/`, shared by every session on the machine. The status line in each session shows running, queued, waiting and review counts.

## Development

```bash
claude plugin validate .
claude plugin test .
```
