# Third-Party Notices

This package's original source code (`Program.cs`, `src/`, build scripts) is licensed under the
EUPL-1.2 — see [LICENSE](LICENSE). The built Windows binaries it publishes
(`OIBusOpcClassicWindows.exe`, for Windows x64, under `runtimes/win-x64/`) additionally embed the
third-party components listed below. They are **not** covered by the EUPL-1.2 and remain under
their own licenses, reproduced here.

This project is an independent implementation. It is **not affiliated with, sponsored by, or
endorsed by the OPC Foundation®**, and it is not certified by the OPC Foundation.
OPC Foundation® and the OPC Foundation logo are registered trademarks of the OPC Foundation. Other
OPC names (OPC Classic, OPC DA, OPC HDA) are used here only to describe the protocols and
components this package interoperates with.

## OPC Foundation® OPC Classic .NET API and RCWs (`OpcNetApi`, `OpcNetApi.Com`, `OpcComRcw`)

The helper is built against the OPC Foundation's OPC Classic .NET API (`OpcNetApi`), its COM
wrapper (`OpcNetApi.Com`) and the OPC Classic Runtime Callable Wrapper (`OpcComRcw`). They are
compiled from source, from the `DotNetRCWs/` directory of the OPC Foundation's
[OPC-Classic-CoreComponents](https://github.com/OPCF-Members/OPC-Classic-CoreComponents)
repository, pinned as the git submodule `vendor/OPC-Classic-CoreComponents` (see `.gitmodules` and
the submodule's commit for the exact revision). Because the helper is published self-contained with
`PublishSingleFile=true` (see `package.json`'s `build:win-*` scripts), these managed assemblies are
embedded in each `OIBusOpcClassicWindows.exe`. They are used unmodified.

The `runtimes/win-x64/` folder also carries this license as `OPC-Foundation-LICENSE.md`.

```text
## MIT License

Copyright (c) 2005-2026, OPC Federation AISBL, All rights reserved.

OPC Foundation MIT License 1.00

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

The complete license agreement can be found here:
http://opcfoundation.org/License/MIT/1.00/
```

### OPC Core Components are not included

This package does **not** include or redistribute the native OPC Classic Core Components (the OPC
proxy/stub DLLs, `OpcEnum`, and related COM registrations). They must be installed separately on
the machine running this package, using the OPC Foundation's own signed installer (or the one
supplied by your OPC server vendor). Their installation and use are governed by the OPC Foundation's
terms for those components, not by this package.

## .NET runtime

The helper is published self-contained, so each `OIBusOpcClassicWindows.exe` embeds the .NET
runtime (`Microsoft.NETCore.App`, .NET 10), licensed under the MIT License:

```text
The MIT License (MIT)

Copyright (c) .NET Foundation and Contributors

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The .NET runtime itself includes third-party components under their own licenses. Their notices
are shipped next to the executable as `runtimes/win-x64/dotnet-runtime-THIRD-PARTY-NOTICES.txt`
(with the license as `dotnet-runtime-LICENSE.txt`), copied at build time from the exact
`Microsoft.NETCore.App` runtime pack embedded in that executable. They are also published at
https://github.com/dotnet/runtime/blob/main/THIRD-PARTY-NOTICES.TXT.
