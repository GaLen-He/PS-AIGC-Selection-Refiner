const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extensionRoot = path.join(__dirname, "..", "cep", "AIGCSelectionRefiner");

test("panel keeps Microsoft Pinyin composition events inside text fields", () => {
  const main = fs.readFileSync(path.join(extensionRoot, "js", "main.js"), "utf8");
  const css = fs.readFileSync(path.join(extensionRoot, "css", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(extensionRoot, "index.html"), "utf8");

  assert.match(main, /function isTextEditingTarget/);
  assert.match(main, /function isImeComposing/);
  assert.match(main, /event\.keyCode === 229|event\.which === 229/);
  assert.match(main, /function enableTextInputIme/);
  assert.match(main, /compositionstart/);
  assert.match(main, /compositionend/);
  assert.match(main, /event\.stopPropagation\(\)/);
  assert.match(main, /enableTextInputIme\(\)/);
  assert.match(css, /input,[\s\S]*textarea[\s\S]*-webkit-user-select:\s*text/);
  assert.match(html, /<html lang="zh-CN">/);
});
