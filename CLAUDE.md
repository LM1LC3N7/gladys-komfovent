# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16), its only
runtime dependency (Modbus TCP goes through `node:net`). It reads a Komfovent
ventilation unit (C6, C6M, C8 controllers) over Modbus TCP (port 502, no
cloud, no authentication) and shows it as one Gladys device; the mode and the
start behind an off-by-default option, "Stop the unit" never behind it. Never
tested with a real device, not affiliated with Komfovent. Read
**[TODO.md](./TODO.md) first**: status, decisions, next milestones.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
gi ci                                     # the whole CI locally (VM tooling)
```

## Architecture

```
index.js                  SDK bootstrap only (boot(): a stop pending in /data goes first)
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                KomfoventApp: the line (one session), polling, backoff, device,
                          states, badge, status, test button, commands, kept stop
src/modbus/client.js      Modbus TCP session: MBAP frames, error kinds, beforeSend/startBy
src/modbus/protocol.js    requests, decoders, write requests (Komfovent's map), pure
src/devices.js            -> the Gladys device and its states (pure)
src/publisher.js          states within 300/min
src/store.js              /data/komfovent-state.json: last read, identity, address, kept stop
src/config.js             config_schema normalized (host, unit_id, allow_commands, interval, language)
src/constants.js          blocks, commands, feature roles, ranges, limits, timings
src/i18n.js               runtime texts (en/fr)
test/fixtures/fakeKomfovent.js  the fake unit (injected connector, and frames for a real TCP server)
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: device `komfovent:unit` (no serial in the
  Modbus map: frozen rule), feature roles in `FEATURES` of
  `src/constants.js`. Every role is always built.
- Manifest keys (`host`, `unit_id`, `allow_commands`, `poll_interval`,
  `language`, the action `test_connection`) are frozen.
- **One Modbus connection at a time, one request at a time**: everything
  goes through `useLine`; a command takes the line from a poll, the stop
  from anything.
- **Commands**: never a switch, a writable binary or a writable fan; the
  mode and the start refused unless `allow_commands` (checked on arrival and
  in `beforeSend`); decided on a fresh read in the same session; written
  within 3.5 s; confirmed only by the echo and a read back equal to the value
  asked; never retried; the ack never waits for Gladys.
- **The stop is never held back** (option, other command, stuck read,
  backoff, controller type, /data, configuration not read). The kept stop is
  never lifted by the time: only by a start pressed with the option or by
  the unit read on twice in a row after it was seen off.
- Only registers 1 and 5 are ever written. Never the firmware, the clock,
  the settings; never hass-komfovent's User-Agent or update checks.
- Never read sooner than the interval (button, scan, reconnection, restart).
- **Answers are hostile**: MBAP frames bounded and checked; implausible
  values unknown; a text is never published as 0; never log the bytes.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network, except `test/realclock.test.js` (127.0.0.1 only).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
