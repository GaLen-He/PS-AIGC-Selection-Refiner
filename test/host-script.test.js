const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const hostPath = path.join(__dirname, "..", "cep", "AIGCSelectionRefiner", "host", "AIGCSelectionRefiner.jsx");

function loadHost(withJson) {
  const context = vm.createContext(withJson ? { JSON } : {});
  if (!withJson) vm.runInContext("this.JSON = undefined;", context);
  vm.runInContext(fs.readFileSync(hostPath, "utf8"), context);
  return context.AIGCSelectionRefiner;
}

test("host serializer emits valid JSON without the ExtendScript JSON global", () => {
  const host = loadHost(false);
  const value = { ok: true, data: { imagePath: "C:\\Temp\\a \"b\".png", n: 3, list: [1, null, false], text: "中文\n" } };
  assert.deepEqual(JSON.parse(host._stringify(value)), value);
});

test("host exports without visible temp documents and preserves task selection snapshots", () => {
  const source = fs.readFileSync(hostPath, "utf8");
  const exportBody = source.slice(source.indexOf("AIGCSelectionRefiner.exportSelection"), source.indexOf("AIGCSelectionRefiner.exportDocument"));
  assert.doesNotMatch(exportBody, /duplicate\(/);
  assert.match(exportBody, /sourceDocument\.selection\.store\(snapshot\)/);
  assert.match(exportBody, /sourceDocument\.activeChannels = sourceChannels/);
  assert.match(exportBody, /selectionChannelName: selectionChannelName/);
  assert.match(exportBody, /sourceDocument\.channels\.getByName\(selectionChannelName\)\.remove\(\)/);
  assert.match(source, /suspendHistory\("AIGC 导出"/);
  assert.match(source, /suspendHistory\("AIGC 回填"/);
  assert.doesNotMatch(source, /toSource\(/);
});

test("selection export flattens artboards before cropping the selected rectangle", () => {
  const source = fs.readFileSync(hostPath, "utf8");
  const exportBody = source.slice(source.indexOf("AIGCSelectionRefiner._exportInternal"), source.indexOf("function exportCroppedInPlace"));
  assert.match(exportBody, /if \(selection\) \{[\s\S]*document\.flatten\(\)[\s\S]*document\.crop\(/);
  assert.ok(exportBody.indexOf("document.flatten()") < exportBody.indexOf("document.crop("), "artboards must be flattened before crop");
});

test("selection jobs remember the active artboard and place the returned layer back inside it", () => {
  const host = fs.readFileSync(hostPath, "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "..", "cep", "AIGCSelectionRefiner", "js", "main.js"), "utf8");
  const exportBody = host.slice(host.indexOf("AIGCSelectionRefiner.exportSelection"), host.indexOf("AIGCSelectionRefiner.exportDocument"));
  const placementBody = host.slice(host.indexOf("AIGCSelectionRefiner._placeInternal"), host.indexOf("AIGCSelectionRefiner.openDocument"));

  assert.match(host, /function captureActiveArtboard/);
  assert.match(exportBody, /var artboard = captureActiveArtboard\(sourceDocument\)/);
  assert.match(exportBody, /artboard: artboard/);
  assert.match(panel, /context\.source, context\.artboard/);
  assert.match(host, /function findArtboard/);
  assert.match(placementBody, /findArtboard\(document, job\.artboard\)/);
  assert.match(placementBody, /layer\.move\(targetArtboard, ElementPlacement\.INSIDE\)/);
});

test("host normalizes exported images to 8-bit RGB PNG for image models", () => {
  const source = fs.readFileSync(hostPath, "utf8");
  assert.match(source, /function normalizeForUpload/);
  assert.match(source, /ChangeMode\.RGB/);
  assert.match(source, /BitsPerChannelType\.EIGHT/);
  assert.match(source, /normalizeForUpload\(document\);\s*savePng/);
});
