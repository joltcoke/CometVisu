/* Client-spec.js
 *
 * copyright (c) 2010-2026, Christian Mayer and the CometVisu contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA
 */

/**
 * Unit tests for cv.io.iobroker.Client. The WebSocket is replaced by a fake that lets the
 * test drive onopen / onmessage / onclose and capture what the client sends.
 */
describe('testing cv.io.iobroker.Client', function () {
  let origWebSocket;
  let sockets;
  let savedTestMode;

  function FakeWebSocket(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    sockets.push(this);
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.prototype.send = function (data) {
    this.sent.push(data);
  };
  FakeWebSocket.prototype.close = function () {
    this.readyState = FakeWebSocket.CLOSED;
  };
  // test helpers
  FakeWebSocket.prototype.open = function () {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) {
      this.onopen({});
    }
  };
  FakeWebSocket.prototype.receive = function (data) {
    if (this.onmessage) {
      this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  };
  FakeWebSocket.prototype.serverClose = function () {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({});
    }
  };

  function lastSocket() {
    return sockets[sockets.length - 1];
  }

  function newClient(url) {
    return new cv.io.iobroker.Client('iobroker', url || 'ws://localhost:8083/');
  }

  beforeEach(function () {
    sockets = [];
    origWebSocket = window.WebSocket;
    window.WebSocket = FakeWebSocket;
    savedTestMode = cv.Config.testMode;
    cv.Config.testMode = true;
  });

  afterEach(function () {
    window.WebSocket = origWebSocket;
    cv.Config.testMode = savedTestMode;
  });

  it('is an iobroker client', function () {
    expect(newClient().getType()).toEqual('iobroker');
  });

  it('url-encodes the credentials into the websocket query', function () {
    const client = newClient();
    client.login(false, { username: 'a b', password: 'p&q' });
    const url = lastSocket().url;
    expect(url).toContain('user=' + encodeURIComponent('a b')); // a%20b
    expect(url).toContain('pass=' + encodeURIComponent('p&q')); // p%26q
    client.terminate();
  });

  it('reports connected only after the ready message and calls the callback', function () {
    const client = newClient();
    const ready = jasmine.createSpy('ready');
    client.login(false, {}, ready);
    const sock = lastSocket();
    sock.open();
    expect(client.isConnected()).toBe(false);
    sock.receive([0, null, '___ready___', null]);
    expect(client.isConnected()).toBe(true);
    expect(ready).toHaveBeenCalled();
    client.terminate();
  });

  it('routes a stateChange message to update()', function () {
    const client = newClient();
    client.update = jasmine.createSpy('update');
    client.login(false, {});
    const sock = lastSocket();
    sock.open();
    sock.receive([0, null, '___ready___', null]);
    sock.receive([0, 5, 'stateChange', ['ebus.0.foo', { val: 21.5, ts: 100, lc: 100 }]]);
    expect(client.update).toHaveBeenCalledWith({ 'ebus.0.foo': 21.5 });
    client.terminate();
  });

  it('answers an engine.io ping with a pong', function () {
    const client = newClient();
    client.login(false, {});
    const sock = lastSocket();
    sock.open();
    sock.receive([1]); // PING
    expect(sock.sent).toContain(JSON.stringify([2])); // PONG
    client.terminate();
  });

  it('getHistory rejects when the socket is not open', async function () {
    const client = newClient();
    client.login(false, {}); // socket stays CONNECTING, no ready
    let error;
    try {
      await client.getHistory('ebus.0.foo', new Date(1000), new Date(2000), {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect('' + error).toContain('not connected');
    client.terminate();
  });

  it('sends a getHistory request and resolves with the response', async function () {
    const client = newClient();
    client.login(false, {});
    const sock = lastSocket();
    sock.open();
    sock.receive([0, null, '___ready___', null]);

    const promise = client.getHistory('ebus.0.foo', new Date(1000), new Date(2000), { aggregate: 'minmax' });

    const frame = JSON.parse(sock.sent[sock.sent.length - 1]);
    expect(frame[2]).toEqual('getHistory');
    expect(frame[3][0]).toEqual('ebus.0.foo');
    const requestId = frame[1];

    const history = [{ ts: 1000, val: 1 }];
    sock.receive([3, requestId, null, [null, history]]);

    const result = await promise;
    expect(result).toEqual(history);
    client.terminate();
  });

  it('stops reconnecting after the server asks to reauthenticate', function () {
    const client = newClient();
    client.login(false, { username: 'x', password: 'wrong' });
    const sock = lastSocket();
    sock.open();
    sock.receive([0, null, 'reauthenticate', null]);
    // a close now must not trigger a reconnect (no new socket is created)
    sock.serverClose();
    expect(sockets.length).toBe(1);
    client.terminate();
  });

  describe('ping keepalive (socket.io compatibility path)', function () {
    beforeEach(function () {
      jasmine.clock().install();
    });
    afterEach(function () {
      jasmine.clock().uninstall();
    });

    function setup(pingInterval) {
      const client = newClient();
      client.login(false, {});
      const sock = lastSocket();
      sock.open();
      // the ___setup___ message carries the ping interval the socket.io backend asks for
      sock.receive([0, null, '___setup___', { pingInterval: pingInterval }]);
      sock.sent.length = 0;
      return { client, sock };
    }

    it('clamps a too-small ping interval up to the engine.io default', function () {
      const { client, sock } = setup(5); // absurdly small
      jasmine.clock().tick(24999);
      expect(sock.sent).not.toContain('2');
      jasmine.clock().tick(2);
      expect(sock.sent).toContain('2'); // fired at ~25000, not 5
      client.terminate();
    });

    it('honours a ping interval within the sane range', function () {
      const { client, sock } = setup(5000);
      jasmine.clock().tick(4999);
      expect(sock.sent).not.toContain('2');
      jasmine.clock().tick(2);
      expect(sock.sent).toContain('2');
      client.terminate();
    });
  });
});
