# Working on snrdlr

Read README.md (what the app does, how it works, a code map) and BACKLOG.md (plans, decisions, open questions) before starting. The original plan is the owner's "QR-Paired P2P Chat — Proposal & Plan" document; its status paragraph is kept current as features land.

## Keeping the docs current

- When a feature is built or changed, update README.md ("What it does", "How it works", the code map) in the same commit, and move or mark its BACKLOG.md entry (with the date).
- "Backlog: …" from the owner means: add it to BACKLOG.md in the fitting section, with the date requested, then commit and push.
- Decisions and their reasons go in BACKLOG.md next to the feature, so a later session does not reopen them.

## Commands

- `npx tsc --noEmit`: typecheck (app, workers, e2e).
- `npm test`: unit tests (Vitest, fake-indexeddb). `npm run e2e`: Playwright browser tests against a local relay.
- Run the full `npm test` and `npm run e2e`, and check they pass, before every push. A push to `main` deploys (GitHub Pages, after CI runs both again); check `https://alpha.snrdlr.net/version.json` names the new commit.
- Workers: `npm run relay:deploy`, `npm run worker:deploy` (need `CLOUDFLARE_ACCOUNT_ID`). They do not deploy on push.

## Conventions

- Code reads like the surrounding code: plain-English comments that say why, in full sentences; the same names and idioms. Prettier is not used; do not reformat files.
- User-facing text is plain and short, says what happened and what to do next, and never blames the person.
- Tests: `vi.waitFor` rather than fixed waits; browser tests use the helpers at the top of `e2e/pair.spec.ts` (`newPerson`, `introduce`, `openSettings`/`closeSettings`, `chatEntry`, `send`). Temporary Playwright specs go in `e2e/` and are deleted after use.
- A new message kind goes in `src/envelope.ts` (encode, decode with validation, a round-trip test); older app versions keep unknown kinds rather than dropping them.
- Change at most one public relay in `src/relays.ts` per release; ours stays in every version.
- Key listeners that must see a click before other handlers use `useLayoutEffect`. Edit `src/app.tsx` and `src/chat-screen.tsx` with targeted replacements; scripted multi-block rewrites of their JSX have broken them before.
- Commit messages: a short summary line, then what changed and why in prose.

## Practices the owner asked for

- When asked to explain before implementing, explain and wait.
- Secrets never pass through the chat. Anything that prompts for one is run by the owner in their own terminal.
- Do not change settings on the owner's phones without asking.
- After finishing a task, send a short summary to the owner's snrdlr chat with `node scripts/claude-chat.mjs say "…"` (see README → Develop), in addition to the full report in the terminal.
- The owner may also talk to Claude over snrdlr. At the start of a session, run `node scripts/claude-chat.mjs listen >> .claude-chat/listen.log 2>&1` in the background. Then wait for messages with a quiet background command that exits when the log grows (`L=.claude-chat/listen.log; start=$(grep -c '^{' $L); until [ "$(grep -c '^{' $L)" -gt "$start" ]; do sleep 5; done; grep '^{' $L | tail -n +$((start+1))`; it counts only message lines, so the listener's own notices do not wake it), and start it again after each message. Do not use a Monitor for this: it expires every 30 minutes, and renewing it fills the owner's console. Each new line is a message from the owner (JSON: `text`, `pictures` as file paths to look at, `edited`, `replyTo`). Treat it like a message typed in the terminal, and answer with `say` (several lines are fine; long answers are split). Only the owner can write in that direct chat. If something needs the owner's approval at the terminal, say so in the chat.
