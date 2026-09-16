# Grok Bot

Grok Bot, xAI's Electron desktop agent app (bundle id `com.anysphere.sand`). Not Grok Build, xAI's coding CLI — that is the separate [`grok`](grok.md) provider.

Mapped against **app version 0.30.0**. The app self-updates, so the parser ignores unknown entry kinds and unknown fields rather than rejecting a file.

- **Source:** `src/providers/grokbot.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/grokbot.test.ts`

## Where it reads from

`$CODEBURN_GROKBOT_DIR`, else the app's Electron userData directory:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Grok Bot/sand-client-persistence` |
| Windows | `%APPDATA%\Grok Bot\sand-client-persistence` |
| Linux | `~/.config/Grok Bot/sand-client-persistence` |

**Not** `~/.grokbot`. That directory is the app's `$SAND_DATA_ROOT` (marked by `.grokbot-data-root-v1`) and holds the host process, the local exec daemon, settings, secrets and content-addressed runtime binaries. Its `agents/<uuid>/store.db` tables are empty on 0.30 and `search-index.db` has no rows: the authoritative agent store lives on the remote box at `/home/box/sand-data/agents/<id>/store.db`, and nothing in `~/.grokbot` carries usage.

## Storage format

JSON. Each file in `sand-client-persistence` is one client slice, named `base32(sliceKey).blob` (RFC 4648, lowercase, unpadded) and containing `{"schemaVersion":N,"value":…}`. Two slices matter:

- `sand.client.slice.account.<accountSlot>.roster.last-roster` — `value.rows[]`, one row per bot, with `id`, `name` ("Reddit Bot", "HN Reviewer"), avatar, unread state and `path`.
- `sand.client.slice.account.<accountSlot>.transcript.replicas.<agentId>` — `value.entries[]`, the transcript.

Transcript entry kinds: `message` (`role` `user`/`assistant`, `content`, optional `fromAgent`/`toAgent` for bot-to-bot), `send-message` (the bot's own output, `message.type` `text`/`widget`/`attachment`/`user-form`/…, optional `wake`), `event` (`event.type: "automation-changed"` with `automationName` — the Routines feature), `user-attachment`. Timestamps are `timestampMs`, ms since the epoch, UTC.

## Sessions and projects

Grok Bot has no projects and no session ids: work is organised as named bots, one per `agentId`, each with a chat thread, an attached browser screen and scheduled **Routines**. One transcript replica is one CodeBurn session, `sessionId` is the `agentId`, and the bot's roster `name` is used as both `project` and `agentName` so the report groups by bot. A bot missing from the roster falls back to its `agentId`.

One call is one `requestId` — the app stamps a prompt and every message the bot emits in reply with the same id.

**Routine runs are not human turns.** A `send-message` carries `wake` (`background-revival`, `handoff-resume`, `agent`) when the bot woke on its own, and a `message` carrying `fromAgent` came from another bot rather than from the person. A request with no bare user message is emitted with an empty `userMessage`, so the task classifier never reads a scheduled run as something someone asked for.

## Token model

**Estimated, always.** The local mirror records no token counts, no cost and no model id — a deep scan of every entry field finds no `usage`, `*Tokens`, `cost` or `model` anywhere, and the same holds for every other slice, for `search-index.db` and for every file under `~/.grokbot`. Input is estimated from the text of the `message` entries in a request (the person's prompt, plus anything another bot sent in), output from the `send-message` content, both through the repo's shared `CHARS_PER_TOKEN`. Cache-read, cache-creation and reasoning tokens are all zero; there is nothing to read them from. Every call sets `costIsEstimated: true`, and the provider is deliberately left out of the provider-name list in `providerCallToCachedCall` (`src/parser.ts:2571`) that carries a tool's own metered cost through the cache, so the cost is recomputed from the estimated tokens.

**The replica is a window, not an archive.** The app keeps roughly the last 200 entries per bot locally. A `lifetime` total covers what is still mirrored, not the bot's whole history.

**No tool calls and no bash commands.** The bots drive a browser and a sandbox shell, but no tool-call or command record reaches this machine — `tools` and `bashCommands` are always empty.

## Pricing

`grokbot-auto` is aliased to `grok-4.6` in `src/models.ts`, xAI's published rate of $2.00 / M input, $6.00 / M output and $0.50 / M cached input. The app serves opaque Cursor `sand-*` model aliases (`sand-78zum5`, `sand-cua`, …) and records none of them locally, so there is no honest per-model attribution to make; pricing it at xAI's current flagship rate, with the cost flagged estimated, is the closest truthful reading.

## Deduplication

Per `grokbot:<agentId>:<requestId>`.

## Quota

**No quota reader, because the credential is not reachable.**

The app's account menu shows "Weekly usage NN%, resets in N days" with a **Change limit** action. In the shipped 0.30.0 renderer that reading comes from two Connect-RPC calls on `aiserver.v1.DashboardService`:

- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus` → `usagePercent`, `nextResetTimestampUtc`, `usesPooledEnterpriseAllowance`, `hasNonZeroIncludedLimit`, `sandTrialExpiresAt`, `grokPlanLabel`. The renderer shows nothing when `usesPooledEnterpriseAllowance` is set.
- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` → `spendLimitUsage { individualUsed, individualLimit }` in cents, which is what "Change limit" edits.

Both are authorised by the Cursor access token the app keeps in `~/Library/Application Support/Grok Bot/sand-secrets.json` under `cursor-accounts.<slot>.cursor-access-token`. Every value there is an Electron `safeStorage` blob (base64 of `v10` plus AES-128-CBC ciphertext, key in the macOS keychain), and CodeBurn does not decrypt an app's safe storage — the same rule stated for "Codex Safe Storage" at `src/quota/codex.ts:109`. Nothing else local carries the plan or the percentage: `local-account.json` has only an email and a display name, and `gateway.json`'s plaintext token authorises the loopback box host, not the dashboard.

`src/quota/cursor.ts` is not a substitute. It reads `cursor.com/api/usage-summary` with the Cursor IDE's own token and reports that dashboard's monthly window — a different allowance on the same vendor's dashboard, not Grok Bot's weekly Sand allowance, and whether the two are even the same account cannot be checked from either side. If Grok Bot ever writes a readable credential, `src/quota/grokbot.ts` would mirror `src/quota/grok.ts` against the two endpoints above with a weekly window.

## Live sessions

Not wired up yet. The signals are there: `sand-session-marker.json` (`pid`, `appVersion`, `startedAtMs`, `aliveAtMs`, `crashSeen`) in the userData directory, `~/.grokbot/local-exec-daemon.json` (`pid`, `inflightCount`), `~/.grokbot/host.lock`, and the roster row's `awaitingUserResponse` / `lastActivityAt`.

## Quirks

- **Two xAI products, two providers.** `grok` is the Grok Build CLI under `~/.grok`; `grokbot` is this desktop app. They share nothing but a vendor.
- **Bots message each other.** A `message` with `fromAgent` is another bot's output arriving here. It is counted as input, because the receiving bot had to read it, and it is not treated as a human turn.
- **`~/.grokbot/inference-router-transcript.json`** is written by a third-party reconstruction of app version 0.18, not by the shipped app. It is ignored.
