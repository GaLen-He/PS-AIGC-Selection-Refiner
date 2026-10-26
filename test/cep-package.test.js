const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const extensionRoot = path.join(root, "cep", "AIGCSelectionRefiner");

test("CEP extension has required installation files", () => {
  assert.equal(fs.existsSync(path.join(extensionRoot, "CSXS", "manifest.xml")), true);
  assert.equal(fs.existsSync(path.join(extensionRoot, "index.html")), true);
  assert.equal(fs.existsSync(path.join(extensionRoot, "js", "api-client.js")), true);
  assert.equal(fs.existsSync(path.join(extensionRoot, "js", "studio-catalog.js")), true);
  assert.equal(fs.existsSync(path.join(extensionRoot, "js", "main.js")), true);
  assert.equal(fs.existsSync(path.join(extensionRoot, "js", "quiet-placement.js")), true);
  assert.equal(fs.existsSync(path.join(extensionRoot, "host", "quiet-placement.exe")), true);
  assert.equal(fs.existsSync(path.join(extensionRoot, "host", "AIGCSelectionRefiner.jsx")), true);
  assert.equal(fs.existsSync(path.join(root, "install-free.bat")), true);
});

test("CEP manifest enables Node without disabling web security", () => {
  const manifest = fs.readFileSync(path.join(extensionRoot, "CSXS", "manifest.xml"), "utf8");

  assert.match(manifest, /Extension Id="com\.company\.aigc\.selection\.refiner"/);
  assert.match(manifest, /Host Name="PHXS"/);
  assert.match(manifest, /--enable-nodejs/);
  assert.doesNotMatch(manifest, /--disable-web-security/);
});

test("CEP panel exposes only gateway connection and generation controls", () => {
  const html = fs.readFileSync(path.join(extensionRoot, "index.html"), "utf8");

  assert.match(html, /id="platformUrl"/);
  assert.match(html, /id="apiKey"[^>]*type="password"/);
  assert.match(html, /id="connectButton"/);
  assert.match(html, /id="modelSelect"/);
  assert.match(html, /id="modelDescription"/);
  assert.match(html, /id="parametersPanel"/);
  assert.ok(html.indexOf('src="js/studio-catalog.js"') < html.indexOf('src="js/api-client.js"'));
  assert.doesNotMatch(html, /manualModelRow|manualModelKey|ModelKey/);
  assert.match(html, /id="prompt"/);
  assert.match(html, /id="submitButton"/);
  assert.match(html, /id="layerTemplate"/);
  assert.match(html, /id="layerList"/);
  assert.ok(html.indexOf('src="js/api-client.js"') < html.indexOf('src="js/layer-plan.js"'));
  assert.ok(html.indexOf('src="js/layer-plan.js"') < html.indexOf('src="js/main.js"'));
  assert.match(html, /id="layeredButton"/);
  assert.match(html, /id="guideCanvas"/);
  assert.match(html, /id="layerStatus"/);
  assert.match(html, /id="retryLayersButton"/);
  assert.doesNotMatch(html, /openLoginButton|checkLoginButton|loginOverlay|loginFrame/);
  assert.doesNotMatch(html, /class="hint"/);
});

test("CEP mixed context loads catalog before client without a relative require", () => {
  const context = vm.createContext({
    module: { exports: {} },
    require(name) {
      assert.equal(name.startsWith('.'), false, 'CEP must use the loaded browser catalog');
      return require(name);
    }
  });
  for (const name of ['studio-catalog.js', 'api-client.js']) {
    vm.runInContext(fs.readFileSync(path.join(extensionRoot, 'js', name), 'utf8'), context);
  }
  assert.equal(typeof context.AIGCGateway.GatewayClient, 'function');
  const catalog = fs.readFileSync(path.join(__dirname, 'fixtures', 'aigc-studio.txt'), 'utf8');
  assert.equal(context.AIGCGateway.parseStudioCatalog(catalog, { groups: [{ model_type: 'image', models: ['Banana-2'] }] })[0].id, 'Banana-2');
});

test("CEP panel uses the AIGC Gateway workflow", () => {
  const main = fs.readFileSync(path.join(extensionRoot, "js", "main.js"), "utf8");
  const apiClient = fs.readFileSync(path.join(extensionRoot, "js", "api-client.js"), "utf8");
  const host = fs.readFileSync(path.join(extensionRoot, "host", "AIGCSelectionRefiner.jsx"), "utf8");
  const combined = main + "\n" + apiClient;

  assert.match(combined, /\/my-models\/api/);
  assert.doesNotMatch(apiClient, /\/aigc\/api\/(image-models|model-list|model-config)/);
  assert.match(combined, /normalizeImageModels/);
  assert.match(main, /readParameterValues/);
  assert.doesNotMatch(main, /请让供应商开放模型配置接口/);
  assert.doesNotMatch(main, /manualModelKey|请填写生图 ModelKey/);
  assert.match(combined, /\/aigc\/api\/apply-upload/);
  assert.match(combined, /\/aigc\/api\/commit-upload/);
  assert.match(combined, /\/aigc\/api\/create-image/);
  assert.match(combined, /\/aigc\/api\/task-detail/);
  assert.match(combined, /\/aigc\/api\/download_wm_url/);
  assert.match(main, /AIGCLayerPlan\.buildLayerJobs/);
  assert.match(main, /AIGCLayerPlan\.chromaKey/);
  assert.match(main, /AIGCLayerPlan\.runPool/);
  assert.doesNotMatch(main, /activeExport/);
  assert.match(host, /function activateDocument/);
  assert.doesNotMatch(host, /placeholder/);
  assert.match(host, /AIGCSelectionRefiner\.exportDocument/);
  assert.match(host, /AIGCSelectionRefiner\.placeLayeredResult/);
  assert.match(host, /AIGCSelectionRefiner\.openDocument/);
  assert.doesNotMatch(combined, /applink\.feishu|\/v1\/api\/trigger\//);
  assert.doesNotMatch(combined, /console\.(log|error)\s*\([^)]*apiKey/i);
});

test("free installer copies to the user CEP extensions folder", () => {
  const installer = fs.readFileSync(path.join(root, "install-free.bat"), "utf8");

  assert.match(installer, /%APPDATA%\\Adobe\\CEP\\extensions/);
  assert.match(installer, /xcopy/);
  assert.doesNotMatch(installer, /PlayerDebugMode/);
});
