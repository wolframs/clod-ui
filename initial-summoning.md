# Initial summoning

Clod UI is a chat UI with no API client in it. Every turn is one headless
`claude` process, spawned and read by a Bun monorepo.

`packages/backend` composes the argv —
`claude -p --input-format stream-json --output-format stream-json --verbose`,
then `--resume` for an existing session, and whatever the turn sets for
`--model`, `--effort`, `--system-prompt` / `--append-system-prompt`,
`--allowedTools` / `--disallowedTools` and `--add-dir`. It spawns that
detached, writes the user message to stdin as stream-JSON, and parses the NDJSON
coming back on stdout into typed events. Each turn gets its own process group so
a cancel can kill the whole tree.

`apps/engine` (Bun + Hono) owns conversations, settings and transcripts, and
re-emits those events over a WebSocket at `/ws`, which accepts
`?since=<lastEventId>` to replay a gap. `apps/web` is the React client that
renders the stream. `packages/contracts` holds the Zod schemas both halves
agree on.

The CLI holds the credentials. The engine stores none of its own.
