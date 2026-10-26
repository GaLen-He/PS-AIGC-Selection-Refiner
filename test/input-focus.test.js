const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const extension = path.join(__dirname, '../cep/AIGCSelectionRefiner');

function loadPanel() {
  const timers = [];
  const interests = [];
  const interestPayloads = [];
  const listeners = new Map();
  let focused = true;
  function eventTarget(target) {
    const handlers = new Map();
    target.addEventListener = (name, handler) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    };
    target.emit = (name, properties = {}) => {
      const event = { target, stopPropagation() {}, ...properties };
      for (const handler of handlers.get(name) || []) handler.call(target, event);
    };
    return target;
  }
  const document = eventTarget({
    activeElement: null,
    hasFocus: () => focused,
    querySelectorAll: () => [],
    documentElement: { contains: target => target.attached !== false }
  });
  const window = eventTarget({
    __adobe_cep__: {
      registerKeyEventsInterest(value) { interestPayloads.push(value); interests.push(value ? JSON.parse(value) : []); },
      evalScript(expression, callback) { listeners.set(expression, callback); }
    }
  });
  const context = vm.createContext({
    window, document, require, Promise, console, Buffer,
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(extension, 'js/CSInterface.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(extension, 'js/main.js'), 'utf8'), context);
  function field(type = 'text', tagName = 'INPUT') {
    const attributes = {};
    const target = eventTarget({
      tagName, type, value: '中文测试', disabled: false, readOnly: false,
      selectionStart: 1, selectionEnd: 3, selectionDirection: 'backward', scrollTop: 17, scrollLeft: 4,
      focusCount: 0, blurCount: 0,
      getAttribute: name => attributes[name],
      setAttribute(name, value) { attributes[name] = value; },
      setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
      focus() { this.focusCount++; document.activeElement = this; this.emit('focus'); },
      blur() { this.blurCount++; if (document.activeElement === this) document.activeElement = null; this.emit('blur'); }
    });
    context.bindTextInputIme(target);
    return target;
  }
  return { context, document, window, field, interests, interestPayloads, timers, listeners, setFocused(value) { focused = value; }, flush() { while (timers.length) timers.shift()(); } };
}

test('CEP keyboard interest follows editable focus and is released on blur', () => {
  const panel = loadPanel();
  const input = panel.field();
  input.focus();
  assert.ok(panel.interests.at(-1)?.some(event => event.keyCode === 229));
  assert.ok(panel.interests.at(-1)?.some(event => event.keyCode === 65));
  input.blur();
  assert.deepEqual(panel.interests.at(-1), []);
  assert.equal(panel.interestPayloads.at(-1), '');
  assert.equal(panel.context.isTextEditingTarget(panel.field('file')), false);
  assert.equal(panel.context.isTextEditingTarget(panel.field('checkbox')), false);
});

test('panel blur clears an abandoned composition and keyboard interest', () => {
  const panel = loadPanel();
  const input = panel.field();
  panel.context.enableTextInputIme();
  input.focus();
  input.emit('compositionstart');
  assert.equal(panel.context.isImeComposing(), true);
  panel.window.emit('blur');
  assert.equal(panel.context.isImeComposing(), false);
  assert.deepEqual(panel.interests.at(-1), []);
});

test('host return repairs stale input focus only after the quiet guard finishes', async () => {
  const panel = loadPanel();
  const input = panel.field('text', 'TEXTAREA');
  input.focus();
  let finishGuard;
  panel.context.quietPlacementGuard = { run(operation) { return operation().then(value => new Promise(resolve => { finishGuard = () => resolve(value); })); } };
  const result = panel.context.evalHost('placeResult', []);
  await Promise.resolve();
  panel.listeners.get('AIGCSelectionRefiner.placeResult()')('{"ok":true,"data":{"layerId":9}}');
  await Promise.resolve();
  assert.equal(input.blurCount, 0);
  finishGuard();
  await result;
  panel.flush();
  assert.equal(input.blurCount, 1);
  assert.equal(input.focusCount, 2);
  assert.equal(input.value, '中文测试');
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection, input.scrollTop, input.scrollLeft], [1, 3, 'backward', 17, 4]);
});

for (const reason of ['composition', 'other-control', 'background', 'disabled', 'detached']) {
  test(`host return never refocuses an input on ${reason}`, async () => {
    const panel = loadPanel();
    const input = panel.field();
    input.focus();
    const result = panel.context.evalHost('discardSelection', []);
    await Promise.resolve();
    if (reason === 'composition') input.emit('compositionstart');
    if (reason === 'other-control') panel.document.activeElement = { tagName: 'BUTTON' };
    if (reason === 'background') panel.setFocused(false);
    if (reason === 'disabled') input.disabled = true;
    if (reason === 'detached') input.attached = false;
    panel.listeners.get('AIGCSelectionRefiner.discardSelection()')('{"ok":true,"data":{}}');
    await result;
    panel.flush();
    assert.equal(input.blurCount, 0);
    assert.equal(input.focusCount, 1);
  });
}

test('a user click repairs panel reactivation without changing the newly clicked caret', () => {
  const panel = loadPanel();
  const input = panel.field();
  panel.context.enableTextInputIme();
  input.focus();
  panel.window.emit('blur');
  panel.window.emit('focus');
  input.selectionStart = input.selectionEnd = 4;
  input.emit('mouseup');
  panel.flush();
  assert.equal(input.blurCount, 1);
  assert.equal(input.selectionStart, 4);
  input.emit('mouseup');
  panel.flush();
  assert.equal(input.blurCount, 1, 'ordinary repeated clicks do not repeatedly reset the IME');
});

test('click recovery never interrupts a live candidate composition', () => {
  const panel = loadPanel();
  const input = panel.field();
  panel.context.enableTextInputIme();
  input.focus();
  panel.window.emit('focus');
  input.emit('compositionstart');
  input.emit('mouseup');
  panel.flush();
  assert.equal(input.blurCount, 0);
});

test('new model parameter inputs register interest on their first focus', () => {
  const panel = loadPanel();
  panel.context.enableTextInputIme();
  const attributes = {};
  const input = {
    tagName: 'INPUT', type: 'text',
    getAttribute: name => attributes[name],
    setAttribute(name, value) { attributes[name] = value; },
    addEventListener() {}
  };
  panel.document.activeElement = input;
  panel.document.emit('focusin', { target: input });
  assert.ok(panel.interests.at(-1)?.some(event => event.keyCode === 229));
});

test('failed host work recovers the same text field and preserves the error', async () => {
  const panel = loadPanel();
  const input = panel.field();
  input.focus();
  const result = panel.context.evalHost('placeResult', []);
  await Promise.resolve();
  panel.listeners.get('AIGCSelectionRefiner.placeResult()')('{"ok":false,"error":"simulated host failure"}');
  await assert.rejects(result, /simulated host failure/);
  panel.flush();
  assert.equal(input.blurCount, 1);
});

test('a caret-changing click during host work cancels the old focus repair', async () => {
  const panel = loadPanel();
  const input = panel.field();
  panel.context.enableTextInputIme();
  input.focus();
  const result = panel.context.evalHost('discardSelection', []);
  await Promise.resolve();
  panel.document.emit('mousedown', { target: input });
  input.selectionStart = input.selectionEnd = 4;
  panel.listeners.get('AIGCSelectionRefiner.discardSelection()')('{"ok":true,"data":{}}');
  await result;
  panel.flush();
  assert.equal(input.blurCount, 0);
  assert.equal(input.selectionStart, 4);
});

test('a missing or throwing CEP key-interest API does not prevent text editing', () => {
  const panel = loadPanel();
  delete panel.window.__adobe_cep__.registerKeyEventsInterest;
  const input = panel.field();
  assert.doesNotThrow(() => input.focus());
  panel.window.__adobe_cep__.registerKeyEventsInterest = () => { throw new Error('unsupported'); };
  assert.doesNotThrow(() => input.focus());
});
