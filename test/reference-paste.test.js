const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function setup() {
  const events = {}, regionEvents = {}, added = [];
  const region = { addEventListener(name, handler) { regionEvents[name] = handler; }, contains(target) { return target === region; } };
  const overlay = { hidden: true };
  const document = { activeElement: null, getElementById(id) { return id === 'connectionOverlay' ? overlay : region; }, addEventListener(name, handler) { events[name] = handler; } };
  const panel = vm.createContext({ require, Buffer, CSInterface: function () {}, window: { addEventListener() {} }, document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../cep/AIGCSelectionRefiner/js/main.js'), 'utf8'), panel);
  panel.connected = true;
  panel.addReferenceFiles = files => { added.push(Array.from(files)); return Promise.resolve(); };
  panel.setStatus = () => {};
  panel.bindReferencePaste();
  return { panel, events, regionEvents, region, document, added };
}

function paste(file, text) {
  return {
    prevented: false,
    clipboardData: { items: file ? [{ kind: 'file', type: file.type, getAsFile: () => file }] : [{ kind: 'string', type: 'text/plain' }], files: file ? [file] : [], getData: () => text || '' },
    preventDefault() { this.prevented = true; }
  };
}

test('hovering reference area pastes a clipboard image once through normal reference validation', async () => {
  const current = setup();
  const image = { name: 'image.png', type: 'image/png', size: 20 };
  current.regionEvents.mouseenter();
  const event = paste(image);
  await current.events.paste(event);
  assert.deepEqual(current.added, [[image]]);
  assert.equal(event.prevented, true);
});

test('clipboard does not intercept prompt text or images outside the reference area', async () => {
  const current = setup();
  const outside = paste({ name: 'image.png', type: 'image/png' });
  await current.events.paste(outside);
  current.regionEvents.mouseenter();
  const text = paste(null, '提示词');
  await current.events.paste(text);
  current.regionEvents.mouseleave();
  await current.events.paste(outside);
  assert.equal(current.added.length, 0);
  assert.equal(outside.prevented, false);
  assert.equal(text.prevented, false);
});

test('focused reference region supports keyboard paste and disconnected panels ignore it', async () => {
  const current = setup();
  current.document.activeElement = current.region;
  const event = paste({ name: 'image.webp', type: 'image/webp' });
  await current.events.paste(event);
  assert.equal(current.added.length, 1);
  current.panel.connected = false;
  await current.events.paste(event);
  assert.equal(current.added.length, 1);
});
