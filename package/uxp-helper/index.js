var photoshop = require('photoshop');
var uxp = require('uxp');
var helperSessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
var createWriter = require('./writer.js').createWriter;
var captureSelection = require('./capture.js').createCapture(photoshop);
var readSnapshot = require('./snapshot-reader.js').createReader(photoshop);
var config = null;
var socket = null;
var reconnectTimer = null;
var queue = Promise.resolve();

async function binaryRequest(resource, options) {
  var response = await fetch('http://127.0.0.1:47391/' + resource, Object.assign({}, options || {}, {
    headers: { Authorization: 'Bearer ' + config.token }
  }));
  if (!response.ok) throw Error('本机像素传输失败（' + response.status + '）');
  return new Uint8Array(await response.arrayBuffer());
}

var writer = createWriter(photoshop, function (identity, offset, length) {
  if (!/^[a-f0-9]{32}$/.test(identity)) throw Error('回贴资源标识无效。');
  return binaryRequest('assets/' + identity + '?offset=' + offset + '&length=' + length);
}, helperSessionId);
var reserve = require('./reservation.js').createReservation(photoshop, helperSessionId, function (identity, offset, length) {
  if (!/^[a-f0-9]{32}$/.test(identity)) throw Error('蒙版资源标识无效。');
  return binaryRequest('assets/' + identity + '?offset=' + offset + '&length=' + length);
});

async function capture(args) {
  if (!args.source || args.source.backgroundSessionId !== helperSessionId) throw Error('选区捕获期间助手会话已变化，请重新提交。');
  if (!/^[a-f0-9]{32}$/.test(args.upload)) throw Error('选区上传标识无效。');
  var result = await captureSelection(args);
  await binaryRequest('captures/' + args.upload, { method: 'POST', body: result.data });
  return { width: result.width, height: result.height };
}

async function snapshot(args) {
  if (!args.source || args.source.backgroundSessionId !== helperSessionId) throw Error('取图期间助手会话已变化，未提交生图。');
  if (!/^[a-f0-9]{32}$/.test(args.upload)) throw Error('图像上传标识无效。');
  var result = await readSnapshot(args);
  await binaryRequest('captures/' + args.upload, { method: 'POST', body: result.data });
  return { width: result.width, height: result.height, bounds: result.bounds, timing: result.timing };
}

function retry() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 3000);
}

async function connect() {
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  try {
    if (!config) {
      var folder = await uxp.storage.localFileSystem.getPluginFolder();
      var file = await folder.getEntry('bridge-token.json');
      config = JSON.parse(await file.read());
      if (!/^[a-f0-9]{64}$/i.test(config.token)) throw Error('后台助手令牌无效。');
    }
    var current = new WebSocket('ws://127.0.0.1:47391/connect?token=' + config.token, 'aigc-return-v1');
    socket = current;
    current.addEventListener('open', function () {
      current.send(JSON.stringify({ type: 'ready', protocol: 1, version: '0.5.30', photoshop: photoshop.app.version, sessionId: helperSessionId }));
    });
    current.addEventListener('message', function (event) {
      var request;
      try { request = JSON.parse(event.data); } catch (error) { return; }
      if (request.type !== 'request' || !request.id) return;
      queue = queue.catch(function () {}).then(async function () {
        var response = { type: 'response', id: request.id, ok: false };
        try {
          if (current.readyState !== 1 || Date.now() >= request.deadline) throw Error('后台请求已超时或面板已关闭。');
          if (request.method === 'place') response.result = await writer.place(Object.assign({}, request.args, { deadline: request.deadline }));
          else if (request.method === 'cleanup') response.result = await writer.cleanup(Object.assign({}, request.args, { deadline: request.deadline }));
          else if (request.method === 'capture') response.result = await capture(Object.assign({}, request.args, { deadline: request.deadline }));
          else if (request.method === 'reserve') response.result = await reserve(Object.assign({}, request.args, { deadline: request.deadline }));
          else if (request.method === 'snapshot') response.result = await snapshot(Object.assign({}, request.args, { deadline: request.deadline }));
          else throw Error('未知的后台命令。');
          response.ok = true;
        } catch (error) {
          response.error = String(error.message || error);
          response.recoveryBlocked = !!error.recoveryBlocked;
          response.retryable = !response.recoveryBlocked && (request.method === 'place' || error.number === 9 || /modal|模态|超时|面板已关闭/i.test(response.error));
          ['number', 'code', 'phase', 'stripe', 'rollbackError', 'pixelInfo', 'compatibilityError', 'compatibilityPhase'].forEach(function (key) {
            if (error[key] !== undefined && error[key] !== null) response[key] = error[key];
          });
        }
        if (current.readyState === 1) current.send(JSON.stringify(response));
      });
    });
    current.addEventListener('close', function () { if (socket === current) socket = null; retry(); });
    current.addEventListener('error', function () { try { current.close(); } catch (error) {} retry(); });
  } catch (error) { retry(); }
}

uxp.entrypoints.setup({ commands: { connect: connect } });
connect();
