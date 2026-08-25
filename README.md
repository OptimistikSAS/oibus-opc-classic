# @oibus/opc-classic-windows

A Windows-only npm package: a small .NET console app wrapping the `Quick.OpcNetApi`/`OpcComRcw`
DCOM interop libraries (OPC Classic DA + HDA), plus the TypeScript driver (`src/index.ts`) that
spawns and talks to it. Used by [OIBus](https://github.com/OptimistikSAS/OIBus)'s `south-opc`
connector via `import { OpcConnection } from '@oibus/opc-classic-windows'`, but has no dependency on
OIBus itself — it's a standalone driver for talking to OPC Classic DA/HDA servers from Node.js on
Windows.

This started as the OPC module of
[OIBusAgentWindows](https://github.com/OptimistikSAS/OIBusAgentRelease), ported out of that
project's OWIN/HTTP agent: instead of a separately installed Windows Service reachable over a
configured `agentUrl`, the calling process spawns this helper itself as a local child process. It
shares its overall design (shared/multiplexed child process, stdio JSON protocol) with two sibling
packages still living inside the OIBus monorepo for now: `@oibus/oledb-windows` and
`@oibus/pi-afsdk-windows`.

## Install

```bash
npm install @oibus/opc-classic-windows
```

Windows only (`os: ["win32"]` in `package.json` — npm will refuse to install it on any other
platform). Requires a real OPC Classic DA or HDA server reachable via DCOM (a local simulator like
the free Matrikon OPC Simulation server, or a real industrial OPC server) to actually connect to —
this package is a client/driver, not a server.

```ts
import { OpcConnection } from '@oibus/opc-classic-windows';

const connection = await OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
const values = await connection.read('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', ['Random.Int1']);
await connection.disconnect();
```

## Framework: net9.0-windows, confirmed by live testing

Unlike `@oibus/pi-afsdk-windows` (needs .NET Framework 4.8 for the AF SDK), this package targets
modern .NET (`net9.0-windows`) — confirmed by live testing against a real Matrikon OPC Simulation
server, not assumed: `Quick.OpcComRcw`/`Quick.OpcNetApi`/`Quick.OpcNetApi.Com` ship `netstandard2.0`/
`netstandard2.1` builds, and DA connect/read/browse worked immediately on net9.0-windows with no
issues at all.

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

Same shared/multiplexed-process design as `@oibus/oledb-windows`/`@oibus/pi-afsdk-windows` (one
process for the whole OIBus instance, connections tracked by a UUID `id`, requests/responses
correlated by `requestId`, commands on the same connection id kept in order via a per-connection task
chain on the .NET side while different connections run fully concurrently, and the process is drained
before exit — see those packages' READMEs for the full rationale).

**OPC-specific difference**: unlike PI (every connection shares one underlying `PIServer`), each
connection here gets its own real `Opc.Server` object on the .NET side — `ConcurrentDictionary<string,
Opc.Server>`, matching `OIBusAgentWindows`'s own `OPCService.cs` `Dictionary<string, Server>` almost
exactly. Different OPC connectors can genuinely target different hosts/servers/DA-or-HDA modes, so
there's no single shared object to fall back to the way PI's "one PI server per machine" assumption
allowed.

**Connect is idempotent and self-healing on failure**, ported from `OPCService.Connect` verbatim:
skips `Connect()` if already connected, lazily creates the server object on first call per id, and on
any connect failure disposes the server and evicts it from the dictionary so the next attempt starts
from a fresh DCOM activation instead of retrying a dead COM object.

**No process-restart error-recovery mechanism** (unlike PI's `ManageError`/`ExceptionList.RestartException`)
— the original agent never had one for OPC either; all reconnect resilience already lived
TS-side in `south-opc.ts` (any read error forces `disconnect()` + `connect()` before rethrowing), and
that's preserved as-is in the ported version.

**No auto-connect on read/browse** (a deliberate deviation from the original agent, which called
`Connect()` at the top of every `ReadValues`/`BrowseNode` call as a self-healing measure) — `read`/
`browse` return `"Not connected"` if the id isn't in the dictionary, matching `@oibus/oledb-windows`/
`@oibus/pi-afsdk-windows`'s "explicit connect required" model. `south-opc.ts`'s own reconnect-on-error
logic is the single source of truth for reconnection, not a second, redundant auto-connect path on
the .NET side.

## DA vs HDA

`mode` (`'da'` | `'hda'`) is a `connect`-time parameter — it picks `Opc.Da.Server` or `Opc.Hda.Server`
up front, matching the original agent (`opcda://`/`opchda://` URL scheme). Read dispatch is a runtime
type check (`server is DAServer` / `is HDAServer`) rather than re-checking `mode`, since the
connection's own server object already carries that information.

- **DA read**: one synchronous `server.Read(items)` call — current/live values only, no paging (DA
  never returns a backlog).
- **HDA read**: ported verbatim from `ReadHDAValues`, including its manual pagination loop —
  `server.ReadRaw`/`ReadProcessed` can report `ResultID.Hda.S_MOREDATA`, so the helper resumes from
  the minimum "max time seen so far" across items that still have more data, releases items that are
  fully drained, and sleeps `intervalReadDelay` ms between pages (a deliberate pacing choice from the
  original agent, not a bug) — until nothing has more data. `aggregate`/`resampling` map to the same
  25-value aggregate ID / 7-value resample-interval-in-seconds switches as the original, with the same
  `default: 0` fallback for anything unrecognized — which is also what makes the item manifest's old
  `resampling` default bug (`'raw'`, not a valid resampling value) harmless: it was never a matched
  case here either, so it always fell through to "no resampling" regardless. No migration needed for
  existing items with that value already stored.

**Browse** (`BrowseNode`/`GetDANodes`/`GetHDANodes` in the original) is ported too, even though
`south-opc.ts` doesn't call it yet — same as the original agent, where it existed in the HTTP API but
was never wired up on the TS side. It's there for a future item-browsing UI feature. Confirmed working
live, including recursive descent into branch nodes — notably, the *original* agent has a real
`NullReferenceException` bug when recursively browsing into a branch node (reproduced directly against
the actual installed agent), which this port does not have.

## Protocol

Newline-delimited JSON on stdin/stdout, requests/responses correlated by `requestId`. `ok` only ever
appears on `connect`/`disconnect`; `read`/`browse` carry no `ok` at all — `error`'s presence is the
only failure signal, `values`/`nodes`' presence the only success signal (same simplified envelope
`@oibus/pi-afsdk-windows` uses, for the same reason: one bulk call either succeeds outright or fails
outright).

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

`items` on a `read` command is a flat list of exact OPC item ids — no name on the wire, same reasoning
as `@oibus/pi-afsdk-windows`'s `PiConnection.read`: the south connector already knows its own items
and maps a raw `nodeId` back to an item name with a plain lookup (OPC Classic items are always exact
references, never a wildcard mask, so there's no PI-style ambiguity to resolve). `aggregate`/
`resampling`/`maxReadValues`/`intervalReadDelay` only matter for an HDA connection — a DA connection
ignores them entirely. `serverInfo` (`{vendorInfo, productVersion, serverState}`, off the server's own
`GetStatus()`) is gathered once on `connect` and carried on every `OpcConnection` — `south-opc.ts` logs
it on connect and surfaces it from `testConnection()`.

## Development

Requires Windows, the .NET 9 SDK, and Node.js ≥20.

```bash
npm install          # dev dependencies (typescript, tsx, @types/node)
npm run build         # tsc -> dist/index.js + dist/index.d.ts
npm test              # runs src/**/*.spec.ts against a fake child process (no real OPC server needed)
dotnet build          # compiles the .NET helper for local testing (bin/Debug/net9.0-windows/...)
```

To exercise the helper against a real OPC server without going through the TS layer, pipe
newline-delimited JSON commands directly at the built exe (see [Protocol](#protocol) below), or set
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
