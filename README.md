# @oibus/opc-classic

A Windows-only npm package: a small .NET console app wrapping the `Quick.OpcNetApi`/`OpcComRcw`
DCOM interop libraries (OPC Classic DA + HDA), plus the TypeScript driver (`src/index.ts`) that
spawns and talks to it. A standalone driver for talking to OPC Classic DA/HDA servers from Node.js
on Windows — no dependency on any other project.

Instead of installing a separate, long-running Windows Service to reach an OPC Classic server, the
calling process spawns this package's helper itself as a local child process on demand, talks to it
over a small stdio JSON protocol, and can stop it again once it's no longer needed.

## Install

```bash
npm install @oibus/opc-classic
```

Windows only (`os: ["win32"]` in `package.json` — npm will refuse to install it on any other
platform). Requires a real OPC Classic DA or HDA server reachable via DCOM (a local simulator like
the free Matrikon OPC Simulation server, or a real industrial OPC server) to actually connect to —
this package is a client/driver, not a server.

```ts
import { OpcConnection } from '@oibus/opc-classic';

const connection = await OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
const values = await connection.read('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', ['Random.Int1']);
await connection.disconnect();
```

## Framework: net9.0-windows, confirmed by live testing

This package targets modern .NET (`net9.0-windows`) — confirmed by live testing against a real
Matrikon OPC Simulation server, not assumed: `Quick.OpcComRcw`/`Quick.OpcNetApi`/`Quick.OpcNetApi.Com`
ship `netstandard2.0`/`netstandard2.1` builds, and DA connect/read/browse worked immediately on
net9.0-windows with no issues at all.

HDA needed one real fix along the way, found by testing, not by inspection: `Matrikon.OPCHDA.Automation`
(a *different* Matrikon product than the DA simulator) is registered as a 32-bit **in-process**
COM DLL (`InprocServer32`), which a 64-bit process cannot load directly — activation failed with
"Class not registered" until the same code was rebuilt as `win-x86`. That turned out to be a red
herring specific to that one Automation-wrapper product, though: the actual DA **simulation server**
(`Matrikon.OPC.Simulation`, `OPCSim.exe`) implements the HDA interfaces too, addressed via the
`opchda://` URL scheme instead of `opcda://` — connecting to `Matrikon.OPC.Simulation` in `hda` mode
works from a normal 64-bit process, with real historized reads confirmed live (raw values, and an
aggregate/resampling read that returned cleanly with no error, just no aggregated data for this
simulator's sparse test data — not a bug). Production OPC HDA servers are essentially always proper
out-of-process/remote DCOM servers, so the in-process-DLL bitness constraint found here is expected
to be rare in practice, not the default case.

## Architecture

A single .NET helper process, spawned lazily on the first `connect()` call and stopped once the
last open connection disconnects, multiplexes any number of concurrent logical connections over one
stdio JSON protocol: each connection is tracked by a UUID `id`, and every request/response carries a
`requestId` so responses (which can legitimately arrive out of order across connections) get matched
back to the right caller. Commands on the same connection id are kept in strict arrival order via a
per-connection task chain on the .NET side, while commands on different connection ids run fully
concurrently. The process is drained (all in-flight work awaited) before it actually exits, so a
short-lived piped run can't lose a response to a race with stdin closing.

Each connection gets its own real `Opc.Server` object on the .NET side — a
`ConcurrentDictionary<string, Opc.Server>` keyed by connection id — since different connections can
genuinely target different hosts, servers, or DA/HDA modes; there's no single object shared across
every connection.

**Connect is idempotent and self-healing on failure**: it skips `Connect()` if already connected,
lazily creates the server object on first call per id, and on any connect failure disposes the
server and evicts it from the dictionary so the next attempt starts from a fresh DCOM activation
instead of retrying a dead COM object.

**No auto-connect on read/browse** — `read`/`browse` return `"Not connected"` if the id isn't in the
dictionary; a caller is expected to `connect()` explicitly first and to own its own reconnect policy
on failure, rather than relying on every read/browse silently reconnecting behind its back.

## DA vs HDA

`mode` (`'da'` | `'hda'`) is a `connect`-time parameter — it picks `Opc.Da.Server` or `Opc.Hda.Server`
up front (`opcda://`/`opchda://` URL scheme). Read dispatch is a runtime type check
(`server is DAServer` / `is HDAServer`) rather than re-checking `mode`, since the connection's own
server object already carries that information.

- **DA read**: one synchronous `server.Read(items)` call — current/live values only, no paging (DA
  never returns a backlog).
- **HDA read**: includes a manual pagination loop — `server.ReadRaw`/`ReadProcessed` can report
  `ResultID.Hda.S_MOREDATA`, so the helper resumes from the minimum "max time seen so far" across
  items that still have more data, releases items that are fully drained, and sleeps
  `intervalReadDelay` ms between pages (a deliberate pacing choice, not a bug) — until nothing has
  more data. `aggregate`/`resampling` map to a 25-value aggregate ID / 7-value
  resample-interval-in-seconds table, with a `default: 0` fallback for anything unrecognized, so an
  invalid or missing value degrades to "raw"/"no resampling" rather than throwing.

**Browse** (flat or recursive node listing, for both DA and HDA) is included too, confirmed working
live, including recursive descent into branch nodes.

## Protocol

Newline-delimited JSON on stdin/stdout, requests/responses correlated by `requestId`. `ok` only ever
appears on `connect`/`disconnect`; `read`/`browse` carry no `ok` at all — `error`'s presence is the
only failure signal, `values`/`nodes`' presence the only success signal (one bulk call either
succeeds outright or fails outright, so there's nothing partial to report through a separate field).

```jsonc
{"requestId":"1","command":"connect","id":"<connection-uuid>","host":"localhost","serverName":"Matrikon.OPC.Simulation","mode":"da"}
{"requestId":"2","command":"read","id":"<connection-uuid>","startTime":"...","endTime":"...","items":["Random.Int1"]}
{"requestId":"3","command":"read","id":"<connection-uuid>","startTime":"...","endTime":"...","items":["Random.Int1"],"aggregate":"average","resampling":"1h","maxReadValues":3600,"intervalReadDelay":200}
{"requestId":"4","command":"browse","id":"<connection-uuid>","nodeId":"","recursive":false}
{"requestId":"5","command":"disconnect","id":"<connection-uuid>"}
```

Responses:

```jsonc
{"requestId":"1","ok":true,"serverInfo":{"vendorInfo":"Matrikon Inc ...","productVersion":"1.9.8629","serverState":"running"}}
{"requestId":"2","values":[{"nodeId":"Random.Int1","timestamp":"2024-01-01T00:00:00.000Z","value":"73","quality":"0xC0"}]}
{"requestId":"4","nodes":[{"name":"Random","nodeId":"Random","isItem":false,"hasChildren":true,"nodes":[]}]}
{"requestId":"5","ok":true}
```

`items` on a `read` command is a flat list of exact OPC item ids — no name on the wire; a caller
already knows which identifier it asked for, so mapping a raw `nodeId` back to its own naming is a
plain lookup on its side (OPC Classic items are always exact references, never a wildcard mask).
`aggregate`/`resampling`/`maxReadValues`/`intervalReadDelay` only matter for an HDA connection — a DA
connection ignores them entirely. `serverInfo` (`{vendorInfo, productVersion, serverState}`, off the
server's own `GetStatus()`) is gathered once on `connect` and carried on every `OpcConnection`.

## Development

Requires Windows, the .NET 9 SDK, and the Node/npm versions pinned in `package.json`'s `engines`
field.

```bash
npm install            # dev dependencies (typescript, tsx, @types/node)
npm run build          # tsc -> dist/index.js + dist/index.d.ts
npm test                # runs src/**/*.spec.ts against a fake child process (no real OPC server needed)
dotnet build            # compiles the .NET helper for local testing (bin/Debug/net9.0-windows/...)
```

To exercise the helper against a real OPC server without going through the TS layer, pipe
newline-delimited JSON commands directly at the built exe (see [Protocol](#protocol) above), or set
`OIBUS_OPC_CLASSIC_WINDOWS_BINARY` to point `resolveOpcBinaryPath()` at a specific build:

```bash
$env:OIBUS_OPC_CLASSIC_WINDOWS_BINARY = "$(pwd)\bin\Debug\net9.0-windows\OIBusOpcClassicWindows.exe"
```

## Release

Releases are cut by pushing a `v*` tag (e.g. `v0.1.1`) — see `.github/workflows/publish.yml`. That
workflow, on a Windows runner:

1. `dotnet publish` for `win-x64`, `win-x86`, and `win-arm64` into `runtimes/<rid>/`.
2. `npm run build` (the TypeScript side).
3. `npm publish` (scoped public package — `publishConfig.access` in `package.json` is already set
   to `"public"`, so no `--access` flag is needed at publish time).

Bump `version` in `package.json` before tagging — npm will reject a publish that reuses an existing
version. `dist/` and `runtimes/` are gitignored (built fresh by CI at publish time, never committed).
