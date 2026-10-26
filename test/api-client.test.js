const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  GatewayClient,
  buildCosAuthorization,
  buildCreateImagePayload,
  buildLayeredPsdPayload,
  buildEndpoints,
  isTerminalStatus,
  normalizeBaseUrl,
  normalizeImageModelConfigs,
  normalizeImageModels,
  normalizeLayeredResult,
  normalizeModels,
  parseTraceId,
  requestBuffer
} = require("../cep/AIGCSelectionRefiner/js/api-client");

test("falls back to Windows curl when the CEP browser request fails", async () => {
  const originalXMLHttpRequest = global.XMLHttpRequest;
  let receivedAuthorization = "";
  const server = http.createServer((request, response) => {
    receivedAuthorization = request.headers.authorization || "";
    response.writeHead(200, {
      "Content-Type": "application/json",
      "X-Trace-Id": "curl-trace"
    });
    response.end('{"models":["curl-model"]}');
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  class FailingXMLHttpRequest {
    open() {}
    setRequestHeader() {}
    send() {
      process.nextTick(() => this.onerror());
    }
  }

  global.XMLHttpRequest = FailingXMLHttpRequest;
  try {
    const address = server.address();
    const response = await requestBuffer(`http://127.0.0.1:${address.port}/v1/models`, {
      method: "GET",
      headers: { Authorization: "Bearer private-test-key" }
    });

    assert.equal(receivedAuthorization, "Bearer private-test-key");
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-trace-id"], "curl-trace");
    assert.equal(response.buffer.toString("utf8"), '{"models":["curl-model"]}');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalXMLHttpRequest === undefined) delete global.XMLHttpRequest;
    else global.XMLHttpRequest = originalXMLHttpRequest;
  }
});

test("Windows curl fallback preserves binary request bodies", async () => {
  const originalXMLHttpRequest = global.XMLHttpRequest;
  const expectedBody = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  let receivedBody = Buffer.alloc(0);
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = Buffer.concat(chunks);
      response.writeHead(201, { "Content-Type": "application/octet-stream" });
      response.end(Buffer.from([9, 8, 7]));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  class FailingXMLHttpRequest {
    open() {}
    setRequestHeader() {}
    send() {
      process.nextTick(() => this.onerror());
    }
  }

  global.XMLHttpRequest = FailingXMLHttpRequest;
  try {
    const address = server.address();
    const response = await requestBuffer(`http://127.0.0.1:${address.port}/upload`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: expectedBody
    });

    assert.deepEqual(receivedBody, expectedBody);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.buffer, Buffer.from([9, 8, 7]));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalXMLHttpRequest === undefined) delete global.XMLHttpRequest;
    else global.XMLHttpRequest = originalXMLHttpRequest;
  }
});

test("uses the CEP browser network stack when XMLHttpRequest is available", async () => {
  const originalXMLHttpRequest = global.XMLHttpRequest;
  let openedUrl = "";

  class FakeXMLHttpRequest {
    constructor() {
      this.headers = {};
      this.status = 0;
      this.response = null;
    }

    open(method, url) {
      this.method = method;
      openedUrl = url;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    getAllResponseHeaders() {
      return "content-type: application/json\r\nx-trace-id: browser-trace\r\n";
    }

    send() {
      const body = Buffer.from('{"models":["browser-model"]}', "utf8");
      this.status = 200;
      this.response = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      process.nextTick(() => this.onload());
    }
  }

  global.XMLHttpRequest = FakeXMLHttpRequest;
  try {
    const response = await requestBuffer("https://ai-gateway.kurogames.com/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer test-key" }
    });

    assert.equal(openedUrl, "https://ai-gateway.kurogames.com/v1/models");
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-trace-id"], "browser-trace");
    assert.equal(response.buffer.toString("utf8"), '{"models":["browser-model"]}');
  } finally {
    if (originalXMLHttpRequest === undefined) delete global.XMLHttpRequest;
    else global.XMLHttpRequest = originalXMLHttpRequest;
  }
});

test("normalizes a supplier URL and builds all gateway endpoints", () => {
  assert.equal(normalizeBaseUrl(" https://ai-gateway.kurogames.com/// "), "https://ai-gateway.kurogames.com");
  assert.deepEqual(buildEndpoints("https://ai-gateway.kurogames.com/"), {
    models: "https://ai-gateway.kurogames.com/my-models/api",
    studio: "https://ai-gateway.kurogames.com/aigc",
    applyUpload: "https://ai-gateway.kurogames.com/aigc/api/apply-upload",
    commitUpload: "https://ai-gateway.kurogames.com/aigc/api/commit-upload",
    createImage: "https://ai-gateway.kurogames.com/aigc/api/create-image",
    createLayeredPsd: "https://ai-gateway.kurogames.com/aigc/api/create-image",
    taskDetail: "https://ai-gateway.kurogames.com/aigc/api/task-detail",
    download: "https://ai-gateway.kurogames.com/aigc/api/download_wm_url"
  });
  assert.throws(() => normalizeBaseUrl("ftp://example.com"), /HTTP/);
});

test("normalizes common model response shapes", () => {
  assert.deepEqual(normalizeModels({ data: [{ id: "Banana-2" }, { id: "Seedream" }] }), ["Banana-2", "Seedream"]);
  assert.deepEqual(normalizeModels({ models: [{ model_key: "A" }, "B"] }), ["A", "B"]);
  assert.deepEqual(normalizeModels([{ ModelKey: "C" }, { name: "D" }, { id: "C" }]), ["C", "D"]);
});

test("keeps only explicitly declared image generation models from a unified catalog", () => {
  assert.deepEqual(normalizeImageModels({
    data: [
      { id: "Hy3", model_type: "chat" },
      { id: "doubao-embedding-vision", model_type: "embedding" },
      { id: "Seedream", model_type: "image_generation" },
      { id: "SDXL", capabilities: ["text-to-image", "image-to-image"] },
      { id: "looks-like-image-but-is-chat", model_type: "chat" }
    ]
  }, true), ["Seedream", "SDXL"]);
});

test("accepts ModelKey entries returned by a dedicated AIGC model endpoint", () => {
  assert.deepEqual(normalizeImageModels({
    Data: {
      Models: [
        { ModelKey: "image-detail-v2", Name: "细节增强 V2" },
        { model_key: "inpaint-v1" }
      ]
    }
  }, false), ["image-detail-v2", "inpaint-v1"]);
});

test("normalizes image model display names and parameter definitions", () => {
  assert.deepEqual(normalizeImageModelConfigs({
    Data: {
      Models: [{
        ModelKey: "image-detail-v2",
        Name: "细节增强 V2",
        Description: "用于局部重绘",
        Parameters: [
          { Name: "strength", Label: "重绘强度", Type: "number", Default: 0.6, Min: 0, Max: 1, Step: 0.1 },
          { name: "style", label: "风格", type: "select", default: "natural", options: ["natural", "sharp"] }
        ]
      }]
    }
  }, false), [{
    id: "image-detail-v2",
    name: "细节增强 V2",
    description: "用于局部重绘",
    parameters: [
      { name: "strength", label: "重绘强度", type: "number", default: 0.6, min: 0, max: 1, step: 0.1, options: [] },
      { name: "style", label: "风格", type: "select", default: "natural", min: undefined, max: undefined, step: undefined, options: ["natural", "sharp"] }
    ]
  }]);
});

test("loads authorized image models and their studio parameters using one key", async () => {
  const requestedPaths = [];
  const authorization = [];
  const server = http.createServer((request, response) => {
    requestedPaths.push(request.url);
    authorization.push(request.headers.authorization);
    if (request.url === "/my-models/api") {
      response.end(JSON.stringify({ groups: [
        { model_type: "chat", models: ["gpt-chat", "Banana-1"] },
        { model_type: "image", models: ["Banana-2", "Tripo-text-to-image"] }
      ] }));
      return;
    }
    if (request.url === "/aigc") {
      response.end('<script src="/aigc/assets/aigc.js?v=changed&amp;build=2"></script>');
      return;
    }
    if (request.url === "/aigc/assets/aigc.js?v=changed&build=2") {
      response.end(fs.readFileSync(path.join(__dirname, "fixtures", "aigc-studio.txt")));
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end('{"message":"unexpected path"}');
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const client = new GatewayClient({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-key" });
    const models = await client.fetchModels();
    assert.deepEqual(models.map(model => model.id), ["Banana-2"]);
    assert.equal(models[0].name, "Banana 2");
    assert.deepEqual(models[0].parameters.map(parameter => parameter.name), ["Resolution", "AspectRatio"]);
    assert.equal(models[0].parameters[0].default, "1k");
    assert.deepEqual(requestedPaths, ["/my-models/api", "/aigc", "/aigc/assets/aigc.js?v=changed&build=2"]);
    assert.deepEqual(authorization, ["Bearer test-key", undefined, undefined]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("returns no models when the authorized groups contain only language models", async () => {
  const requestedPaths = [];
  const server = http.createServer((request, response) => {
    requestedPaths.push(request.url);
    if (request.url === "/my-models/api") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"groups":[{"model_type":"chat","models":["Hy3","qwen3-rerank"]}]}');
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end('{"message":"not found"}');
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const client = new GatewayClient({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-key" });
    assert.deepEqual(await client.fetchModels(), []);
    assert.deepEqual(requestedPaths, ["/my-models/api"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("builds the minimum image generation payload", () => {
  assert.deepEqual(buildCreateImagePayload({
    modelKey: "Banana-2",
    prompt: "增强细节",
    imageUrl: "https://cdn.example.com/input.png"
  }), {
    ModelKey: "Banana-2",
    Prompt: "增强细节",
    FileInfos: [{
      Type: "Url",
      Category: "Image",
      Usage: "Reference",
      Url: "https://cdn.example.com/input.png"
    }]
  });
});

test("includes selected model parameters in the image generation payload", () => {
  assert.deepEqual(buildCreateImagePayload({
    modelKey: "Banana-2",
    prompt: "增强细节",
    imageUrl: "https://cdn.example.com/input.png",
    parameters: { Resolution: "1k", AspectRatio: "4:3" }
  }).OutputConfig, {
    Resolution: "1k",
    AspectRatio: "4:3"
  });
});

test("submits the selection first and every extra reference in its displayed order", () => {
  const payload = buildCreateImagePayload({
    modelKey: "Banana-2",
    prompt: "保持图1，参考图2材质和图3光影",
    imageUrl: "https://cdn.example.com/selection.png",
    referenceUrls: ["https://cdn.example.com/material.png", "https://cdn.example.com/lighting.png"],
    parameters: { AspectRatio: "4:3" }
  });
  assert.deepEqual(payload.FileInfos.map(file => file.Url), [
    "https://cdn.example.com/selection.png", "https://cdn.example.com/material.png", "https://cdn.example.com/lighting.png"
  ]);
  assert.ok(payload.FileInfos.every(file => file.Type === "Url" && file.Category === "Image" && file.Usage === "Reference"));
  assert.equal(payload.OutputConfig.AspectRatio, "4:3");
});

test("an invalid extra reference stops submission rather than silently sending fewer images", () => {
  const options = { modelKey: "image-model", prompt: "edit", imageUrl: "https://cdn.example.com/selection.png" };
  for (const referenceUrls of [[""], [null], [123], "https://cdn.example.com/extra.png"]) {
    assert.throws(() => buildCreateImagePayload({ ...options, referenceUrls }), /参考图/);
  }
});

test("builds a layered PSD payload with explicit layer instructions", () => {
  const payload = buildLayeredPsdPayload({
    modelKey: "Image-2.5",
    prompt: "把角色、背景、特效分层",
    imageUrl: "https://cdn.example.com/source.png",
    layerCount: 6
  });

  assert.equal(payload.ModelKey, "Image-2.5");
  assert.equal(payload.OutputFormat, "LayeredPSD");
  assert.equal(payload.LayerCount, 6);
  assert.match(payload.Prompt, /把角色、背景、特效分层/);
  assert.match(payload.Prompt, /透明 PNG 图层清单/);
  assert.deepEqual(payload.FileInfos, [{
    Type: "Url",
    Category: "Image",
    Usage: "Reference",
    Url: "https://cdn.example.com/source.png"
  }]);
});

test("normalizes layered PSD results from common gateway shapes", () => {
  const result = normalizeLayeredResult({
    Response: {
      PsdUrl: "/output/result.psd",
      LayerInfos: [
        { Name: "背景/天空", Url: "/layers/bg.png", Left: 0, Top: 0, Width: 1024, Height: 768, Opacity: 95 },
        { name: "角色", imageBase64: "abc", bounds: { left: 30, top: 20, right: 230, bottom: 420 } }
      ]
    }
  }, "https://ai-gateway.kurogames.com");

  assert.equal(result.psdUrl, "https://ai-gateway.kurogames.com/output/result.psd");
  assert.deepEqual(result.layers, [
    {
      name: "背景_天空",
      url: "https://ai-gateway.kurogames.com/layers/bg.png",
      base64: "",
      left: 0,
      top: 0,
      width: 1024,
      height: 768,
      opacity: 95
    },
    {
      name: "角色",
      url: "",
      base64: "abc",
      left: 30,
      top: 20,
      width: 200,
      height: 400,
      opacity: 100
    }
  ]);
});

test("downloads layered PNG results to a temporary directory", async () => {
  const png = Buffer.from("fake-png");
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(png);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "layered-test-"));

  try {
    const address = server.address();
    const client = new GatewayClient({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-key" });
    const result = await client.downloadLayeredResult({ layers: [{ name: "前景", url: "/layer.png" }] }, directory);

    assert.equal(result.layers.length, 1);
    assert.equal(path.dirname(result.layers[0].path), directory);
    assert.equal(fs.readFileSync(result.layers[0].path).toString("utf8"), "fake-png");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("parses trace ids and terminal task states", () => {
  assert.equal(parseTraceId({ trace_id: "trace-a" }), "trace-a");
  assert.equal(parseTraceId({ Response: { TraceId: "trace-b" } }), "trace-b");
  assert.equal(parseTraceId({}, { "x-trace-id": "trace-c" }), "trace-c");
  assert.equal(isTerminalStatus("done"), true);
  assert.equal(isTerminalStatus("fail"), true);
  assert.equal(isTerminalStatus("timeout"), true);
  assert.equal(isTerminalStatus("processing"), false);
});

test("creates deterministic Tencent COS V5 authorization without exposing the secret", () => {
  const authorization = buildCosAuthorization({
    method: "PUT",
    pathname: "/folder/selection.png",
    headers: {
      "content-type": "image/png",
      host: "bucket.cos.ap-guangzhou.myqcloud.com",
      "x-cos-security-token": "token-value"
    },
    secretId: "temporary-id",
    secretKey: "temporary-secret",
    startTime: 1700000000,
    endTime: 1700000600
  });

  assert.match(authorization, /^q-sign-algorithm=sha1&q-ak=temporary-id&/);
  assert.match(authorization, /q-header-list=content-type;host;x-cos-security-token&/);

  const crypto = require("node:crypto");
  const keyTime = "1700000000;1700000600";
  const httpString = ["put", "/folder/selection.png", "", "content-type=image%2Fpng&host=bucket.cos.ap-guangzhou.myqcloud.com&x-cos-security-token=token-value", ""].join("\n");
  const signKey = crypto.createHmac("sha1", "temporary-secret").update(keyTime).digest("hex");
  const stringToSign = ["sha1", keyTime, crypto.createHash("sha1").update(httpString).digest("hex"), ""].join("\n");
  const expected = crypto.createHmac("sha1", signKey).update(stringToSign).digest("hex");
  assert.match(authorization, new RegExp("q-signature=" + expected + "$"));
  assert.match(authorization, /q-signature=[0-9a-f]{40}$/);
  assert.doesNotMatch(authorization, /temporary-secret/);
});


