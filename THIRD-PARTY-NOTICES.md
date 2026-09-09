# Third-Party Notices

This package's original source code (`Program.cs`, `src/`) is licensed under the EUPL-1.2 —
see [LICENSE](LICENSE). The built Windows binaries it publishes (`OIBusOpcClassicWindows.exe`,
one per architecture under `runtimes/<rid>/`) additionally embed the components described below,
which are **not** covered by the EUPL-1.2 and remain under their own license.

## OPC Foundation OPC Classic .NET API / RCW redistributables

`OpcClassicWindows.csproj` references the NuGet packages `Quick.OpcNetApi`, `Quick.OpcComRcw`, and
`Quick.OpcNetApi.Com` (v2.1.108), which package OPC Foundation's official OPC Classic .NET API and
DCOM Runtime Callable Wrapper (RCW) interop assemblies for OPC DA/HDA. Because the helper is
published self-contained with `PublishSingleFile=true` (see `package.json`'s `build:win-*`
scripts), these managed assemblies are embedded directly into the single-file
`OIBusOpcClassicWindows.exe` for each platform.

Copyright © OPC Foundation. All rights reserved.

Use and redistribution of these components is governed by the **OPC Foundation Redistributables
Agreement, v1.3**: https://opcfoundation.org/license/redistributables/1.3/

That agreement requires, among other things:

- OPC Foundation's copyright and trademark notices must be preserved (this notice satisfies that
  for this package).
- The distributor's own copyright notice must accompany distributed programs (see `LICENSE` and
  the `Copyright`/`Company` metadata embedded in `OIBusOpcClassicWindows.exe`).
- **Anyone who further redistributes this package, or any software that includes it (including
  OIBus itself), must preserve this notice and require their own distributees and end users to
  agree to terms that protect the OPC Foundation at least as much as that Agreement.**
- The OPC Foundation's redistributed code must never be modified or distributed in a way that
  subjects it to an "Excluded License" — a license (such as the EUPL, GPL, or similar copyleft
  terms) that would require its source to be disclosed or that would grant others the right to
  modify it. This package only *references* the OPC Foundation redistributables via NuGet
  (`PackageReference`); it does not vendor or modify their source, and the EUPL-1.2 licensing this
  repository's own source under does not extend to them.
- OPC Foundation trademarks may not be used in a way that suggests endorsement by, or origin from,
  the OPC Foundation. This project is an independent implementation and is not certified or
  endorsed by the OPC Foundation.

The OPC Foundation deliverables are provided "AS-IS", without warranty of any kind, per the terms
of that Agreement.
