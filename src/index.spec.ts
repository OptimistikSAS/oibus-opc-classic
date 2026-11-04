import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpcBridge, OpcConnection, __resetSharedBridgeForTesting, extractFromPkgSnapshotIfNeeded, resolveOpcBinaryPath } from './index';

/** A fake child process good enough to drive readline + event listeners the same way a real one would. */
class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = { write: mock.fn((_chunk: string) => true) };
  kill = mock.fn(() => true);

  respond(response: unknown): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }

  lastRequest(): Record<string, unknown> {
    const calls = this.stdin.write.mock.calls;
    return JSON.parse((calls[calls.length - 1].arguments[0] as string).trim());
  }
}

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe('OpcBridge', () => {
  let lastChild: FakeChildProcess;
  const spawnMock = mock.fn((_binary: string, _args: Array<string>, _options: unknown) => {
    lastChild = new FakeChildProcess();
    return lastChild as unknown as ReturnType<typeof spawnMock>;
  });

  beforeEach(() => {
    spawnMock.mock.resetCalls();
  });

  describe('resolveOpcBinaryPath', () => {
    afterEach(() => {
      delete process.env.OIBUS_OPC_CLASSIC_WINDOWS_BINARY;
    });

    it('returns the OIBUS_OPC_CLASSIC_WINDOWS_BINARY override when set', () => {
      process.env.OIBUS_OPC_CLASSIC_WINDOWS_BINARY = 'C:\\custom\\OIBusOpcClassicWindows.exe';
      assert.strictEqual(resolveOpcBinaryPath(), 'C:\\custom\\OIBusOpcClassicWindows.exe');
    });

    it('throws for an unsupported architecture', () => {
      const originalArch = process.arch;
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      try {
        assert.throws(() => resolveOpcBinaryPath(), /Unsupported architecture/);
      } finally {
        Object.defineProperty(process, 'arch', { value: originalArch });
      }
    });
  });

  // Confirmed directly against a real @yao-pkg/pkg-bundled executable: spawning straight from a
  // pkg snapshot path (e.g. `C:\snapshot\...\OIBusOpcClassicWindows.exe`) fails with ENOENT even
  // though the same path reads fine via `fs.readFileSync` — the OS process-creation call needs a
  // real file, not pkg's virtual filesystem. Exercised here against a throwaway scratch path (not
  // the package's own real `runtimes/` folder) so this test can't clobber a real build artifact if
  // it happens to run after `npm run build:win-*` has already populated that folder.
  describe('extractFromPkgSnapshotIfNeeded', () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-classic-pkg-test-'));
    const bundledPath = path.join(scratchDir, 'OIBusOpcClassicWindows.exe');

    beforeEach(() => {
      fs.writeFileSync(bundledPath, 'fake binary contents');
    });

    afterEach(() => {
      delete (process as unknown as { pkg?: unknown }).pkg;
    });

    it('returns the bundled path unchanged outside of a pkg bundle', () => {
      assert.strictEqual(extractFromPkgSnapshotIfNeeded(bundledPath), bundledPath);
    });

    it('copies the binary to a real temp file and returns that path when running under pkg', () => {
      (process as unknown as { pkg?: unknown }).pkg = {};
      const resolved = extractFromPkgSnapshotIfNeeded(bundledPath);
      assert.notStrictEqual(resolved, bundledPath);
      assert.ok(resolved.includes('oibus-opc-classic'));
      assert.strictEqual(fs.readFileSync(resolved, 'utf8'), 'fake binary contents');
    });
  });

  it('tags every outgoing command with a distinct requestId and resolves by matching it back', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = new OpcBridge('binary.exe', spawnMock as any);
    const first = bridge.send({ command: 'read', id: 'a' });
    const second = bridge.send({ command: 'read', id: 'b' });

    const req1 = JSON.parse((lastChild.stdin.write.mock.calls[0].arguments[0] as string).trim());
    const req2 = JSON.parse((lastChild.stdin.write.mock.calls[1].arguments[0] as string).trim());
    assert.notStrictEqual(req1.requestId, req2.requestId);

    // Answer out of order — the second request's response arrives first.
    lastChild.respond({ requestId: req2.requestId, values: [] });
    lastChild.respond({ requestId: req1.requestId, values: [] });

    assert.deepStrictEqual(await second, { requestId: req2.requestId, values: [] });
    assert.deepStrictEqual(await first, { requestId: req1.requestId, values: [] });
  });

  it('fails every pending request when the process exits unexpectedly', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = new OpcBridge('binary.exe', spawnMock as any);
    const pending = bridge.send({ command: 'read', id: 'a' });
    lastChild.emit('exit', 1, null);
    await assert.rejects(pending, { message: /exited unexpectedly/ });
    assert.strictEqual(bridge.isRunning, false);
  });

  it('fails a send() issued while spawning failed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = new OpcBridge('binary.exe', spawnMock as any);
    const pending = bridge.send({ command: 'connect', id: 'a' });
    lastChild.emit('error', new Error('spawn ENOENT'));
    await assert.rejects(pending, { message: 'spawn ENOENT' });
  });

  it('stop() kills the process and rejects anything still pending', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = new OpcBridge('binary.exe', spawnMock as any);
    const pending = bridge.send({ command: 'read', id: 'a' });
    bridge.stop();
    await assert.rejects(pending, { message: 'OPC Classic helper process was stopped' });
    assert.strictEqual(lastChild.kill.mock.calls.length, 1);
  });
});

describe('OpcConnection', () => {
  let lastChild: FakeChildProcess;
  const spawnMock = mock.fn((_binary: string, _args: Array<string>, _options: unknown) => {
    lastChild = new FakeChildProcess();
    return lastChild as unknown as ReturnType<typeof spawnMock>;
  });
  const fakeServerInfo = { vendorInfo: 'Matrikon Inc', productVersion: '1.9.8629', serverState: 'running' };

  beforeEach(() => {
    spawnMock.mock.resetCalls();
    setPlatform('win32');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __resetSharedBridgeForTesting(() => new OpcBridge('binary.exe', spawnMock as any));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('rejects immediately on a non-Windows platform without touching the shared bridge', async () => {
    setPlatform('linux');
    await assert.rejects(OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da'), { message: /Windows/ });
    assert.strictEqual(spawnMock.mock.calls.length, 0);
  });

  it('connects with host/serverName/mode and exposes the returned serverInfo', async () => {
    const connectPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    const request = lastChild.lastRequest();
    assert.deepStrictEqual(
      { command: request.command, host: request.host, serverName: request.serverName, mode: request.mode },
      { command: 'connect', host: 'localhost', serverName: 'Matrikon.OPC.Simulation', mode: 'da' }
    );
    lastChild.respond({ ...request, ok: true, serverInfo: fakeServerInfo });
    const connection = await connectPromise;
    assert.deepStrictEqual(connection.serverInfo, fakeServerInfo);
  });

  it('shares one process across two concurrent connections and answers both independently', async () => {
    const firstConnectPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const first = await firstConnectPromise;

    const secondConnectPromise = OpcConnection.connect('otherhost', 'Some.Other.Server', 'hda');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const second = await secondConnectPromise;

    assert.strictEqual(spawnMock.mock.calls.length, 1, 'only one helper process for both connections');

    const readA = first.read('2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', ['Random.Int1']);
    const readB = second.read('2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', ['Random.Int2']);
    const reqA = JSON.parse((lastChild.stdin.write.mock.calls[2].arguments[0] as string).trim());
    const reqB = JSON.parse((lastChild.stdin.write.mock.calls[3].arguments[0] as string).trim());
    assert.notStrictEqual(reqA.id, reqB.id, 'each connection keeps its own id');

    // Answer B first, then A — order must not matter.
    lastChild.respond({ requestId: reqB.requestId, values: [{ nodeId: 'Random.Int2', timestamp: 'x', value: '1', quality: '0xC0' }] });
    lastChild.respond({ requestId: reqA.requestId, values: [{ nodeId: 'Random.Int1', timestamp: 'x', value: '2', quality: '0xC0' }] });
    assert.deepStrictEqual(await readB, [{ nodeId: 'Random.Int2', timestamp: 'x', value: '1', quality: '0xC0' }]);
    assert.deepStrictEqual(await readA, [{ nodeId: 'Random.Int1', timestamp: 'x', value: '2', quality: '0xC0' }]);
  });

  it('keeps the shared process alive until the last connection disconnects', async () => {
    const firstPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const first = await firstPromise;

    const secondPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const second = await secondPromise;

    const firstDisconnect = first.disconnect();
    lastChild.respond({ ...lastChild.lastRequest(), ok: true });
    await firstDisconnect;
    assert.strictEqual(lastChild.kill.mock.calls.length, 0, 'still one connection using the shared process');

    const secondDisconnect = second.disconnect();
    lastChild.respond({ ...lastChild.lastRequest(), ok: true });
    await secondDisconnect;
    assert.strictEqual(lastChild.kill.mock.calls.length, 1, 'process stopped once the last connection left');
  });

  it('releases the shared process reference when connect() itself fails', async () => {
    const failingPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), error: 'Class not registered' });
    await assert.rejects(failingPromise, { message: 'Class not registered' });
    assert.strictEqual(lastChild.kill.mock.calls.length, 1, 'nothing else was using the process, so it is torn down');

    const nextPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    await nextPromise;
    assert.strictEqual(spawnMock.mock.calls.length, 2, 'a fresh process is spawned for the next attempt');
  });

  it('read() passes HDA options through and rejects when the helper reports a query failure', async () => {
    const connectPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'hda');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const connection = await connectPromise;

    const readPromise = connection.read('2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', ['Random.Int1'], {
      aggregate: 'average',
      resampling: '1h'
    });
    const request = lastChild.lastRequest();
    assert.strictEqual(request.aggregate, 'average');
    assert.strictEqual(request.resampling, '1h');
    lastChild.respond({ ...request, error: 'OPC RPC broken' });
    await assert.rejects(readPromise, { message: 'OPC RPC broken' });
  });

  it('read() rejects once the connection is closed', async () => {
    const connectPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const connection = await connectPromise;
    const disconnectPromise = connection.disconnect();
    lastChild.respond({ ...lastChild.lastRequest(), ok: true });
    await disconnectPromise;

    await assert.rejects(connection.read('2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', ['Random.Int1']), {
      message: 'Connection is closed'
    });
  });

  it('browse() returns the node tree and rejects on failure', async () => {
    const connectPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const connection = await connectPromise;

    const browsePromise = connection.browse('', true);
    const request = lastChild.lastRequest();
    assert.strictEqual(request.command, 'browse');
    assert.strictEqual(request.recursive, true);
    const nodes = [{ name: 'Random', nodeId: 'Random', isItem: false, hasChildren: true, nodes: [] }];
    lastChild.respond({ ...request, nodes });
    assert.deepStrictEqual(await browsePromise, nodes);

    const failingBrowse = connection.browse('bad-node', false);
    lastChild.respond({ ...lastChild.lastRequest(), error: 'bad node id' });
    await assert.rejects(failingBrowse, { message: 'bad node id' });
  });

  it('browse() rejects once the connection is closed', async () => {
    const connectPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const connection = await connectPromise;
    const disconnectPromise = connection.disconnect();
    lastChild.respond({ ...lastChild.lastRequest(), ok: true });
    await disconnectPromise;

    await assert.rejects(connection.browse('', false), { message: 'Connection is closed' });
  });

  it('disconnect() is idempotent', async () => {
    const connectPromise = OpcConnection.connect('localhost', 'Matrikon.OPC.Simulation', 'da');
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, serverInfo: fakeServerInfo });
    const connection = await connectPromise;
    const first = connection.disconnect();
    lastChild.respond({ ...lastChild.lastRequest(), ok: true });
    await first;

    await assert.doesNotReject(connection.disconnect());
    assert.strictEqual(lastChild.kill.mock.calls.length, 1);
  });
});
