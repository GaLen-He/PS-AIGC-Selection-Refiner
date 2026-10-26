var http = require('http');
var crypto = require('crypto');
var fs = require('fs');
var URL = require('url').URL;

function createBridge(options) {
  options = options || {};
  var secret = options.secret;
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret)) throw Error('后台助手未安装，请运行完整安装包中的安装脚本。');
  var assets = new Map();
  var captures = new Map();
  var pending = new Map();
  var sockets = new Set();
  var peer = null;
  var ready = false;
  var helperSessionId = null;
  var starting = null;
  var stopped = false;
  var connectedWaiters = [];
  var server = http.createServer(handleHttp);

  function unavailable(message) {
    var error = Error(message || '后台助手未连接，结果会保留，不会切换文档。请确认完整安装并重启过 Photoshop。');
    error.backgroundUnavailable = true;
    return error;
  }

  function authorized(value) {
    var provided = Buffer.from(String(value || ''));
    var expected = Buffer.from(secret);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }

  function finishCapture(identity, body) {
    var capture = captures.get(identity);
    if (!capture || body.length > capture.limit) throw Error('选区蒙版上传超过安全上限。');
    fs.writeFileSync(capture.path, body);
    capture.length = body.length;
  }

  function handleHttp(request, response) {
    if (!authorized(String(request.headers.authorization || '').replace(/^Bearer /, ''))) { response.writeHead(403); response.end(); return; }
    var url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch (error) { response.writeHead(400); response.end(); return; }
    var match = /^\/assets\/([a-f0-9]{32})$/.exec(url.pathname);
    if (request.method === 'GET' && match && assets.has(match[1])) {
      var asset = assets.get(match[1]);
      var size;
      try { size = Buffer.isBuffer(asset) ? asset.length : fs.statSync(asset).size; }
      catch (error) { response.writeHead(404); response.end(); return; }
      var offset = Number(url.searchParams.get('offset') || 0);
      var length = Number(url.searchParams.get('length') || size);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 ||
          offset + length > size || length > 8 * 1024 * 1024) { response.writeHead(400); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': length, 'Cache-Control': 'no-store' });
      if (Buffer.isBuffer(asset)) response.end(asset.slice(offset, offset + length));
      else fs.createReadStream(asset, { start: offset, end: offset + length - 1 }).on('error', function () { response.destroy(); }).pipe(response);
      return;
    }
    match = /^\/captures\/([a-f0-9]{32})$/.exec(url.pathname);
    if (request.method === 'POST' && match && captures.has(match[1])) {
      var captureSlot = captures.get(match[1]);
      var chunks = [];
      var received = 0;
      request.on('data', function (chunk) {
        received += chunk.length;
        if (captures.get(match[1]) !== captureSlot || received > captureSlot.limit) { request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on('end', function () {
        try { finishCapture(match[1], Buffer.concat(chunks)); response.writeHead(200); response.end('ok'); }
        catch (error) { response.writeHead(400); response.end(); }
      });
      return;
    }
    response.writeHead(404); response.end();
  }

  function frame(text) {
    var bytes = Buffer.from(text);
    var header;
    if (bytes.length < 126) header = Buffer.from([129, bytes.length]);
    else { header = Buffer.alloc(4); header[0] = 129; header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
    return Buffer.concat([header, bytes]);
  }

  function disconnect(socket) {
    if (socket.aigcHeartbeat) clearInterval(socket.aigcHeartbeat);
    sockets.delete(socket);
    if (peer !== socket) return;
    peer = null; ready = false; helperSessionId = null;
    pending.forEach(function (entry) { clearTimeout(entry.timer); entry.reject(unavailable('后台连接中断，结果已保留，重新打开面板后会继续。')); });
    pending.clear();
  }

  function message(socket, text) {
    var data;
    try { data = JSON.parse(text); } catch (error) { socket.destroy(); return; }
    if (data.type === 'ready' && data.protocol === 1) {
      helperSessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
      ready = true;
      connectedWaiters.splice(0).forEach(function (waiter) { clearTimeout(waiter.timer); waiter.resolve(); });
      if (options.onReady) options.onReady(data);
      return;
    }
    if (data.type !== 'response' || !pending.has(data.id)) return;
    var entry = pending.get(data.id);
    pending.delete(data.id); clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else {
      var error = Error(data.error || '后台回贴失败，结果已保留。');
      error.retryable = !!data.retryable;
      error.recoveryBlocked = !!data.recoveryBlocked;
      ['number', 'code', 'phase', 'stripe', 'rollbackError', 'pixelInfo', 'compatibilityError', 'compatibilityPhase'].forEach(function (key) {
        if (data[key] !== undefined && data[key] !== null) error[key] = data[key];
      });
      entry.reject(error);
    }
  }

  server.on('upgrade', function (request, socket, head) {
    var url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch (error) { socket.destroy(); return; }
    if (url.pathname !== '/connect' || !authorized(url.searchParams.get('token')) || request.headers['sec-websocket-version'] !== '13' ||
        request.headers['sec-websocket-protocol'] !== 'aigc-return-v1' || !request.headers['sec-websocket-key'] || peer) { socket.destroy(); return; }
    var accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: aigc-return-v1\r\n\r\n');
    peer = socket; sockets.add(socket);
    var lastResponse = Date.now();
    socket.setKeepAlive(true, 10000);
    socket.aigcHeartbeat = setInterval(function () {
      if (Date.now() - lastResponse >= (options.staleMs || 30000)) { socket.destroy(); disconnect(socket); return; }
      socket.write(Buffer.from([137, 0]));
    }, options.heartbeatMs || 10000);
    socket.aigcHeartbeat.unref();
    var buffer = Buffer.alloc(0);
    var fragments = [];
    var fragmentedSize = 0;
    function receive(chunk) {
      lastResponse = Date.now();
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        var opcode = buffer[0] & 15;
        var final = !!(buffer[0] & 128);
        var length = buffer[1] & 127;
        var offset = 2;
        if (!(buffer[1] & 128) || length === 127) { socket.destroy(); return; }
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + length) return;
        var mask = buffer.slice(offset, offset + 4);
        var bytes = Buffer.from(buffer.slice(offset + 4, offset + 4 + length));
        for (var index = 0; index < bytes.length; index += 1) bytes[index] ^= mask[index % 4];
        buffer = buffer.slice(offset + 4 + length);
        if (opcode === 8) { socket.end(Buffer.from([136, 0])); return; }
        if (opcode === 9 && final && length <= 125) { socket.write(Buffer.concat([Buffer.from([138, length]), bytes])); continue; }
        if (opcode === 10) continue;
        if (opcode !== 1 && opcode !== 0 || opcode === 1 && fragments.length || opcode === 0 && !fragments.length) { socket.destroy(); return; }
        fragments.push(bytes); fragmentedSize += bytes.length;
        if (fragmentedSize > 1024 * 1024) { socket.destroy(); return; }
        if (final) { message(socket, Buffer.concat(fragments).toString('utf8')); fragments = []; fragmentedSize = 0; }
      }
    }
    socket.on('data', receive); socket.on('error', function () { disconnect(socket); }); socket.on('close', function () { disconnect(socket); });
    if (head.length) receive(head);
  });

  function start() {
    if (stopped) return Promise.reject(unavailable());
    if (starting) return starting;
    starting = new Promise(function (resolve, reject) {
      function failed(error) { reject(unavailable('后台连接端口不可用：' + error.message)); }
      server.once('error', failed);
      server.listen(options.port === undefined ? 47391 : options.port, '127.0.0.1', function () {
        server.removeListener('error', failed);
        resolve();
      });
    }).catch(function (error) {
      starting = null;
      throw error;
    });
    return starting;
  }

  function waitReady() {
    return start().then(function () {
      if (ready && peer) return;
      if (stopped) throw unavailable();
      return new Promise(function (resolve, reject) {
        var waiter = { resolve: resolve, reject: reject, timer: null };
        waiter.timer = setTimeout(function () {
          var index = connectedWaiters.indexOf(waiter);
          if (index >= 0) connectedWaiters.splice(index, 1);
          reject(unavailable());
        }, options.waitMs === undefined ? 5000 : options.waitMs);
        connectedWaiters.push(waiter);
      });
    });
  }

  return {
    start: start,
    port: function () { var address = server.address(); return address && address.port; },
    isReady: function () { return ready && !!peer; },
    sessionId: function () { return ready && peer ? helperSessionId : null; },
    waitReady: waitReady,
    registerAsset: function (value) {
      if (!Buffer.isBuffer(value) && !(typeof value === 'string' && fs.existsSync(value))) throw Error('后台回贴资源无效。');
      var identity = crypto.randomBytes(16).toString('hex'); assets.set(identity, value); return identity;
    },
    releaseAsset: function (identity) { assets.delete(identity); },
    request: function (method, args) {
      return waitReady().then(function () {
        return new Promise(function (resolve, reject) {
          var identity = crypto.randomBytes(16).toString('hex');
          var timer = setTimeout(function () { pending.delete(identity); reject(unavailable('后台处理超时，结果已保留；恢复时会检查已有图层以免重复。')); }, options.requestMs || 120000);
          pending.set(identity, { resolve: resolve, reject: reject, timer: timer });
          if (!peer || !ready) { clearTimeout(timer); pending.delete(identity); reject(unavailable()); return; }
          peer.write(frame(JSON.stringify({ type: 'request', id: identity, method: method, args: args, deadline: Date.now() + (options.requestMs || 120000) })));
        });
      });
    },
    capture: function (context, filePath) {
      var identity = crypto.randomBytes(16).toString('hex');
      var limit = context.selection.width * context.selection.height;
      if (!(limit > 0 && limit <= 100000000)) return Promise.reject(Error('选区蒙版尺寸超出安全范围。'));
      captures.set(identity, { path: filePath, limit: limit, length: 0 });
      var bridge = this;
      return bridge.request('capture', { documentId: context.documentId, source: context.source, historyStamp: context.historyStamp,
        selection: context.selection, upload: identity }).then(function (result) {
        var captured = captures.get(identity);
        if (!captured || captured.length !== limit) throw Error('选区蒙版快照不完整，未提交生图。');
        return result;
      }).finally(function () { captures.delete(identity); });
    },
    snapshot: function (context, filePath) {
      var identity = crypto.randomBytes(16).toString('hex');
      captures.set(identity, { path: filePath, limit: 2048 * 2048 * 4, length: 0 });
      return this.request('snapshot', { documentId: context.documentId, source: context.source, historyStamp: context.historyStamp,
        selection: context.selection, upload: identity }).then(function (result) {
        var captured = captures.get(identity);
        if (!result || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width <= 0 || result.height <= 0 ||
          result.width > 2048 || result.height > 2048 || !captured || captured.length !== result.width * result.height * 4) {
          throw Error('图像像素快照不完整，未提交生图。');
        }
        result.path = filePath;
        return result;
      }).finally(function () { captures.delete(identity); });
    },
    close: function () {
      stopped = true;
      pending.forEach(function (entry) { clearTimeout(entry.timer); entry.reject(unavailable('面板已关闭，任务会保留等待恢复。')); });
      pending.clear();
      connectedWaiters.splice(0).forEach(function (waiter) { clearTimeout(waiter.timer); waiter.reject(unavailable()); });
      ready = false; peer = null; helperSessionId = null;
      sockets.forEach(function (socket) { if (socket.aigcHeartbeat) clearInterval(socket.aigcHeartbeat); socket.destroy(); });
      assets.clear(); captures.clear();
      return new Promise(function (resolve) { if (server.listening) server.close(resolve); else resolve(); });
    }
  };
}

module.exports = { createBridge: createBridge };
