var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function createStore(directory) {
  function valid(name, value) {
    if (name !== 'tasks' && name !== 'settings') throw Error('恢复存档名称无效。');
    return name === 'tasks' ? Array.isArray(value) : !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function write(name, value) {
    if (!valid(name, value)) throw Error('恢复存档格式无效。');
    fs.mkdirSync(directory, { recursive: true });
    var destination = path.join(directory, name + '.json');
    var temporary = destination + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    var descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 384);
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, value: value }), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, destination);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  function read(name, fallback) {
    if (!valid(name, fallback)) throw Error('恢复存档格式无效。');
    var filename = path.join(directory, name + '.json');
    if (!fs.existsSync(filename)) {
      write(name, fallback);
      return fallback;
    }
    var saved = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    if (!saved || saved.version !== 1 || !valid(name, saved.value)) throw Error('恢复存档损坏。');
    return saved.value;
  }

  return { read: read, write: write };
}

module.exports = { createStore: createStore };
