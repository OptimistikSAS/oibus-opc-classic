# @oibus/opc-classic

A Windows-only npm package: a small .NET console app wrapping the OPC Classic .NET API and RCWs
of the OPC Foundation® (`OpcNetApi`/`OpcNetApi.Com`/`OpcComRcw`, DCOM interop for OPC Classic DA + HDA), plus the TypeScript driver (`src/index.ts`) that
spawns and talks to it. A standalone driver for talking to OPC Classic DA/HDA servers from Node.js
on Windows — no dependency on any other project.

Instead of installing a separate, long-running Windows Service to reach an OPC Classic server, the
calling process spawns this package's helper itself as a local child process on demand, talks to it
over a small stdio JSON protocol, and can stop it again once it's no longer needed.

## License & third-party notices

This repository's own source (`Program.cs`, `src/`) is licensed under the EUPL-1.2 — see
[LICENSE](LICENSE). The published Windows binaries additionally embed, unmodified and not covered
by the EUPL:

- the OPC Foundation's OPC Classic .NET API and RCWs (`OpcNetApi`, `OpcNetApi.Com`, `OpcComRcw`),
  built from the OPC Foundation's
  [OPC-Classic-CoreComponents](https://github.com/OPCF-Members/OPC-Classic-CoreComponents)
  repository (pinned as the `vendor/OPC-Classic-CoreComponents` git submodule) and licensed under
  the **OPC Foundation MIT License 1.00** (Copyright (c) 2005-2026, OPC Federation AISBL);
- the .NET runtime (self-contained publish), licensed under the **MIT License** (Copyright (c)
  .NET Foundation and Contributors), with its own third-party notices.

The full license texts are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and each
`runtimes/<rid>/` folder ships them next to the executable.

The native **OPC Core Components** (proxy/stub DLLs, `OpcEnum`) are **not** included: install them
separately on the target machine with the OPC Foundation's signed installer (or the one your OPC
server vendor supplies).

This project is not affiliated with or endorsed by the OPC Foundation.

## Install

```bash
npm install @oibus/opc-classic
```

Windows only (`os: ["win32"]` in `package.json` — npm will refuse to install it on any other
platform). Requires the OPC Core Components to be installed on the machine (see above), and a real
OPC Classic DA or HDA server reachable via DCOM (a local simulator like
the free Matrikon OPC Simulation server, or a real industrial OPC server) to actually connect to —
this package is a client/driver, not a server.

```ts
import { OpcConnection } from '@oibus/opc-classic';

const connection = await OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
const values = await connection.read('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', ['Random.Int1']);
await connection.disconnect();
```

## Framework: net10.0-windows

The helper targets `net10.0-windows` (.NET 10, LTS) and builds the OPC Foundation's `OpcNetApi`,
`OpcNetApi.Com` and `OpcComRcw` from source via `ProjectReference`s into the
`vendor/OPC-Classic-CoreComponents` submodule, which multi-target `net10.0-windows` among others.

The live testing described below against a Matrikon OPC Simulation server was done with an earlier
`net9.0-windows` build that used third-party NuGet repackagings (`Quick.OpcNetApi` & co.) of the
same OPC Foundation code; the TypeScript API and the stdio protocol are unchanged.

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

## Works inside a `pkg`-bundled application too

If the calling application is itself bundled into a single executable with
[`pkg`](https://github.com/vercel/pkg) or [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg),
`resolveOpcBinaryPath()` handles that automatically — but it's worth knowing why, since it's not
obvious and was only found by actually building and running a pkg-bundled test app against this
package, not by inspection.

Inside a pkg bundle, paths resolved relative to `__dirname` point into pkg's virtual snapshot
filesystem (something like `C:\snapshot\...`). Reading such a path with `fs` works fine — pkg patches
`fs` to understand it — but `child_process.spawn()` does not: the OS process-creation call needs a
real file on the real filesystem, and a snapshot path isn't one. Confirmed directly: spawning the
helper straight from its snapshot path fails with `ENOENT`, even though `fs.readFileSync` on that
exact path succeeds. So when `process.pkg` is set (pkg's own marker for "running inside a bundle"),
`resolveOpcBinaryPath()` copies the embedded binary out to a real file under `os.tmpdir()` first and
returns that path instead — written via a per-process temp name and an atomic rename into place, so
two pkg-bundled instances of the calling application starting around the same time on the same
machine (a real scenario — e.g. two separate Windows services, both using this package) can't observe
or spawn a partially-written file.

The consuming application still needs to tell `pkg` to actually embed the runtime binaries in the
first place — they won't be picked up automatically. Add this package's `runtimes` folder to the
consuming application's own `pkg.assets` in its `package.json`:

```json
"pkg": {
  "assets": ["node_modules/@oibus/opc-classic/runtimes/**/*"]
}
```

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

Requires Windows, the .NET 10 SDK, and the Node/npm versions pinned in `package.json`'s `engines`
field. The OPC Foundation's .NET API/RCW sources come from a git submodule, so clone with
submodules (or initialize them in an existing checkout):

```bash
git clone --recurse-submodules https://github.com/OptimistikSAS/oibus-opc-classic.git
git submodule update --init   # in an existing checkout
```

To move to a newer upstream revision, check out the wanted commit in
`vendor/OPC-Classic-CoreComponents` and commit the updated submodule pointer (Renovate also proposes
submodule updates).

```bash
npm install             # dev dependencies (typescript, tsx, @types/node)
npm run build           # tsc -> dist/index.js + dist/index.d.ts
npm test                 # runs src/**/*.spec.ts against a fake child process (no real OPC server needed)
dotnet build             # compiles the .NET helper for quick local testing (bin/Debug/net10.0-windows/...)
```

`dotnet build` is enough to iterate on the .NET side quickly, but its output isn't in the layout
`resolveOpcBinaryPath()` expects at runtime (`runtimes/<rid>/`). Two ways to bridge that:

- Point `resolveOpcBinaryPath()` at the `dotnet build` output directly, for fast iteration:
  ```bash
  $env:OIBUS_OPC_CLASSIC_WINDOWS_BINARY = "$(pwd)\bin\Debug\net10.0-windows\OIBusOpcClassicWindows.exe"
  ```
- Or build a real self-contained binary into `runtimes/<rid>/`, matching what a published install
  actually ships (see [Release](#release) below):
  ```bash
  npm run build:win-x64    # or build:win-x86, build:win-arm64, or build:runtimes for all three
  ```

To exercise the helper directly without going through the TS layer at all, pipe newline-delimited
JSON commands at the built exe (see [Protocol](#protocol) above).

## Release

Releases are cut by pushing a `v*` tag (e.g. `v0.1.1`) — see `.github/workflows/publish.yml`. That
workflow, on a Windows runner:

1. `npm run build:runtimes` — runs `build:win-x64`/`build:win-x86`/`build:win-arm64` (each a plain
   `dotnet publish -r <rid> --self-contained -p:PublishSingleFile=true -o runtimes/<rid>`), so the
   same commands can be run locally to reproduce exactly what CI ships.
2. `npm run build` (the TypeScript side).
3. `npm publish` (scoped public package — `publishConfig.access` in `package.json` is already set
   to `"public"`, so no `--access` flag is needed at publish time).

Bump `version` in `package.json` before tagging — npm will reject a publish that reuses an existing
version. `dist/` and `runtimes/` are gitignored (built fresh by CI at publish time, never committed).
