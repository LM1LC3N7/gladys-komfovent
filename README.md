# gladys-komfovent

[Gladys Assistant](https://gladysassistant.com) external integration for
**Komfovent** heat recovery ventilation with a **C6, C6M or C8** controller,
through its **Modbus TCP** interface on the local network (port 502, no
cloud, no password): supply, extract, outdoor and panel temperatures, fan
levels, current mode, on/off, filter clogging, heat exchanger efficiency,
CO2 or humidity sensors, fault, warning and alarm codes; the mode and "Start
the unit" behind an off-by-default option, and "Stop the unit" never behind
that option. **Never tested with a real device. Not affiliated with
Komfovent.** Modbus TCP has no authentication: keep the unit on a trusted
network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (KomfoventApp)
                                  ├─ src/modbus/client.js    one Modbus TCP session at a time, bounded MBAP frames
                                  ├─ src/modbus/protocol.js  requests and decoders (pure)
                                  ├─ src/devices.js          the device and its states (pure)
                                  ├─ src/publisher.js        states within 300/min
                                  └─ src/store.js            /data/komfovent-state.json
```

- **Reads**: one Modbus TCP connection per poll (every 60 s, 30 s – 1 h,
  start to start), five holding register reads (1-34, 900-955, 600-610,
  200-214, 1000-1001: the ranges of hass-komfovent), then closed. The
  secondary blocks (alarms, sensor types, firmware) come last and never stop
  the values read before them. Never sooner than the interval (test button,
  Discovery, reconnection, unchanged configuration, container restart: the
  time of the last read is kept in `/data`, written at most once a minute,
  before the read). Failures retried after 30 s to 5 min, never under the
  interval.
- **Device**: `ext:<selector>:komfovent:unit` (the Modbus map gives no
  serial number; the address is never part of the id). Every feature is
  always published; no switch, no writable binary or fan.
- **Commands** (`allow_commands`, off by default): one `text/select` (mode:
  away, normal, intensive, boost, register 5) and the "Start the unit"
  button (register 1 = 1). A command takes the line from a poll, reads
  on/off, mode, status bits and controller type again in its own session,
  is refused on a fault, while stopping, when the controller type differs
  from the one learnt or /data is unreadable; the mode also on a unit off or
  in stand-by and while a stop is kept. Written within 3.5 s of the click or
  not at all, confirmed only by the echo and the value read back (by 4.3 s).
- **Stop the unit** (protective, register 1 = 0): never behind the option,
  takes the line from anything, cancels a command not written yet, retried
  for 3.5 s, goes to the address kept in `/data` when the configuration is
  not read yet. Then **kept** in `/data`: never lifted by the time, only by
  "Start the unit" or by the unit read on twice in a row after it was seen
  off; resent (three times at most) when the unit reads on before it was
  seen off; sent again at container start, before the configuration, when
  it may not have landed.
- **Not done**: firmware updates (hass-komfovent's update entity is not
  ported, nor its User-Agent), setpoints, schedules, clock, alarm and filter
  resets, air flows.

## Development

```bash
npm install
npm test             # node --test (fake Gladys of the SDK, fake unit, mocked clock, real clock x20)
npm run lint
npm run format:check
npm run audit
npm run cover        # cover.png, plain Node
```

See [CLAUDE.md](CLAUDE.md) for the rules and [TODO.md](TODO.md) for the
status and the decisions.

## Credits and license

Register map ported from [hass-komfovent](https://github.com/lnagel/hass-komfovent)
(MIT) and checked against Komfovent's Modbus manuals; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This integration is
licensed under the Apache License 2.0 ([LICENSE](LICENSE)).
