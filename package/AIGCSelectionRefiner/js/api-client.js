(function (root, factory) {
  var api = factory(root && root.AIGCStudioCatalog ? root.AIGCStudioCatalog : require("./studio-catalog"));
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.AIGCGateway = api;
  }
}(this, function (studioCatalog) {
  "use strict";

  var crypto = require("crypto");
  var childProcess = require("child_process");
  var fs = require("fs");
  var http = require("http");
  var https = require("https");
  var nodeUrl = require("url");
  var os = require("os");
  var path = require("path");

  function normalizeBaseUrl(value) {
    var normalized = String(value || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(normalized)) {
      throw new Error("供应商 URL 必须以 HTTP 或 HTTPS 开头。");
    }
    return normalized;
  }

  function buildEndpoints(baseUrl) {
    var base = normalizeBaseUrl(baseUrl);
    return {
      models: base + "/my-models/api",
      studio: base + "/aigc",
      applyUpload: base + "/aigc/api/apply-upload",
      commitUpload: base + "/aigc/api/commit-upload",
      createImage: base + "/aigc/api/create-image",
      createLayeredPsd: base + "/aigc/api/create-image",
      taskDetail: base + "/aigc/api/task-detail",
      download: base + "/aigc/api/download_wm_url"
    };
  }

  function resolveUrl(baseUrl, value) {
    var text = String(value || "");
    if (/^https?:\/\//i.test(text)) return text;
    var base = normalizeBaseUrl(baseUrl);
    if (text.charAt(0) === "/") {
      var originMatch = base.match(/^(https?:\/\/[^\/]+)/i);
      return (originMatch ? originMatch[1] : base) + text;
    }
    return base + "/" + text.replace(/^\/+/, "");
  }

  function firstValue(object, names) {
    var index;
    if (!object || typeof object !== "object") return undefined;
    for (index = 0; index < names.length; index += 1) {
      if (object[names[index]] !== undefined && object[names[index]] !== null) {
        return object[names[index]];
      }
    }
    return undefined;
  }

  function unwrapResponse(data) {
    return firstValue(data, ["Response", "response", "Data", "data"]) || data || {};
  }

  function normalizeModels(payload) {
    var source = payload;
    var models = [];
    var seen = {};

    if (!Array.isArray(source)) {
      source = firstValue(source, ["models", "Models", "data", "Data"]);
    }
    if (source && !Array.isArray(source)) {
      source = firstValue(source, ["models", "Models", "data", "Data"]);
    }
    if (!Array.isArray(source)) return models;

    source.forEach(function (item) {
      var id = typeof item === "string"
        ? item
        : firstValue(item, ["id", "model", "model_key", "ModelKey", "name", "Name"]);
      id = id === undefined || id === null ? "" : String(id).replace(/^\s+|\s+$/g, "");
      if (id && !seen[id]) {
        seen[id] = true;
        models.push(id);
      }
    });
    return models;
  }

  function modelList(payload) {
    var source = payload;
    if (!Array.isArray(source)) {
      source = firstValue(source, ["models", "Models", "data", "Data"]);
    }
    if (source && !Array.isArray(source)) {
      source = firstValue(source, ["models", "Models", "data", "Data"]);
    }
    return Array.isArray(source) ? source : [];
  }

  function isExplicitImageModel(item) {
    var fields;
    var text;
    if (!item || typeof item !== "object") return false;
    fields = [
      firstValue(item, ["model_type", "modelType", "ModelType", "type", "Type"]),
      firstValue(item, ["category", "Category"]),
      firstValue(item, ["capabilities", "Capabilities", "capability", "Capability"]),
      firstValue(item, ["output_modalities", "outputModalities", "OutputModalities"])
    ];
    text = fields.map(function (value) {
      if (Array.isArray(value)) return value.join(" ");
      if (value && typeof value === "object") return JSON.stringify(value);
      return value === undefined || value === null ? "" : String(value);
    }).join(" ").toLowerCase();
    return /(^|[^a-z])(image([_ -]?(generation|generator|editing|edit))?|text[_ -]?to[_ -]?image|image[_ -]?to[_ -]?image|inpaint|outpaint|txt2img|img2img)([^a-z]|$)/.test(text);
  }

  function normalizeImageModels(payload, requireImageCapability) {
    return normalizeImageModelConfigs(payload, requireImageCapability).map(function (model) {
      return model.id;
    });
  }

  function normalizeParameter(parameter, fallbackName) {
    var source = parameter && typeof parameter === "object" ? parameter : {};
    var name = firstValue(source, ["name", "Name", "key", "Key", "field", "Field"]) || fallbackName;
    var type = String(firstValue(source, ["type", "Type"]) || "text").toLowerCase();
    var options = firstValue(source, ["options", "Options", "values", "Values", "enum", "Enum"]);
    if (!name) return null;
    if (["select", "boolean", "number", "integer", "text"].indexOf(type) < 0) type = "text";
    return {
      name: String(name),
      label: String(firstValue(source, ["label", "Label", "title", "Title", "displayName", "DisplayName"]) || name),
      type: type,
      default: firstValue(source, ["default", "Default", "defaultValue", "DefaultValue"]),
      min: firstValue(source, ["min", "Min", "minimum", "Minimum"]),
      max: firstValue(source, ["max", "Max", "maximum", "Maximum"]),
      step: firstValue(source, ["step", "Step"]),
      options: Array.isArray(options) ? options : []
    };
  }

  function normalizeParameters(value) {
    var parameters = [];
    if (Array.isArray(value)) {
      value.forEach(function (parameter) {
        var normalized = normalizeParameter(parameter);
        if (normalized) parameters.push(normalized);
      });
      return parameters;
    }
    if (value && typeof value === "object") {
      Object.keys(value).forEach(function (name) {
        var normalized = normalizeParameter(value[name], name);
        if (normalized) parameters.push(normalized);
      });
    }
    return parameters;
  }

  function normalizeImageModelConfigs(payload, requireImageCapability) {
    var source = modelList(payload);
    var models = [];
    var seen = {};
    if (requireImageCapability) source = source.filter(isExplicitImageModel);
    source.forEach(function (item) {
      var model = item && typeof item === "object" ? item : {};
      var id = typeof item === "string"
        ? item
        : firstValue(model, ["id", "model", "model_key", "ModelKey", "key", "Key"]);
      var name;
      var description;
      var parameters;
      id = id === undefined || id === null ? "" : String(id).replace(/^\s+|\s+$/g, "");
      if (!id || seen[id]) return;
      seen[id] = true;
      name = typeof item === "string"
        ? id
        : firstValue(model, ["display_name", "displayName", "DisplayName", "name", "Name", "label", "Label"]);
      description = typeof item === "string"
        ? ""
        : firstValue(model, ["description", "Description", "desc", "Desc"]);
      parameters = typeof item === "string"
        ? []
        : normalizeParameters(firstValue(model, ["parameters", "Parameters", "params", "Params", "schema", "Schema"]));
      models.push({
        id: id,
        name: String(name || id),
        description: String(description || ""),
        parameters: parameters
      });
    });
    return models;
  }

  function buildCreateImagePayload(options) {
    if (!options || !options.modelKey) throw new Error("请选择模型。");
    if (!options.prompt) throw new Error("请输入提示词。");
    if (!options.imageUrl) throw new Error("没有取得上传后的参考图地址。");
    var references = options.referenceUrls === undefined ? [] : options.referenceUrls;
    if (!Array.isArray(references) || references.some(function (url) { return typeof url !== "string" || !url.replace(/^\s+|\s+$/g, ""); })) {
      throw new Error("额外参考图地址不完整，已停止提交，请重新添加参考图。");
    }
    var payload = {
      ModelKey: options.modelKey,
      Prompt: options.prompt,
      FileInfos: [options.imageUrl].concat(references).map(function (url) {
        return { Type: "Url", Category: "Image", Usage: "Reference", Url: url };
      })
    };
    if (options.parameters && Object.keys(options.parameters).length) {
      payload.OutputConfig = options.parameters;
    }
    return payload;
  }

  function buildLayeredPrompt(prompt, layerCount) {
    var count = Math.max(1, Number(layerCount || 6));
    return [
      String(prompt || "").replace(/^\s+|\s+$/g, ""),
      "请把参考图拆成可编辑分层 PSD 方案。",
      "优先输出透明 PNG 图层清单，图层按从背景到底层、前景到顶层的顺序排列。",
      "每个图层需要包含 name、imageUrl 或 imageBase64、left、top、width、height、opacity。",
      "建议图层数量不超过 " + count + " 个；保持原图尺寸、构图、光影和边缘自然。"
    ].join("\n");
  }

  function buildLayeredPsdPayload(options) {
    if (!options || !options.modelKey) throw new Error("请选择模型。");
    if (!options.prompt) throw new Error("请输入分层需求。");
    if (!options.imageUrl) throw new Error("没有取得上传后的原图地址。");
    var layerCount = Math.max(1, Number(options.layerCount || 6));
    return {
      ModelKey: options.modelKey,
      Prompt: buildLayeredPrompt(options.prompt, layerCount),
      EnhancePrompt: "Disabled",
      OutputFormat: "LayeredPSD",
      LayerMode: "TransparentPngLayers",
      LayerCount: layerCount,
      FileInfos: [{
        Type: "Url",
        Category: "Image",
        Usage: "Reference",
        Url: options.imageUrl
      }]
    };
  }

  function sanitizeLayerName(name, fallbackIndex) {
    var cleaned = String(name || ("AI 图层 " + fallbackIndex))
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^\s+|\s+$/g, "");
    return cleaned || ("AI 图层 " + fallbackIndex);
  }

  function numberValue(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function normalizeLayerEntry(layer, baseUrl, index) {
    var bounds = firstValue(layer, ["bounds", "Bounds", "rect", "Rect"]) || {};
    var url = firstValue(layer, ["url", "Url", "imageUrl", "ImageUrl", "LayerUrl", "layerUrl"]);
    var base64 = firstValue(layer, ["imageBase64", "ImageBase64", "base64", "Base64"]);
    var leftValue = firstValue(layer, ["left", "Left", "x", "X"]);
    var topValue = firstValue(layer, ["top", "Top", "y", "Y"]);
    var widthValue = firstValue(layer, ["width", "Width"]);
    var heightValue = firstValue(layer, ["height", "Height"]);
    var rightValue = firstValue(layer, ["right", "Right"]);
    var bottomValue = firstValue(layer, ["bottom", "Bottom"]);
    var left = numberValue(leftValue !== undefined ? leftValue : firstValue(bounds, ["left", "Left", "x", "X"]), 0);
    var top = numberValue(topValue !== undefined ? topValue : firstValue(bounds, ["top", "Top", "y", "Y"]), 0);
    var width = numberValue(widthValue !== undefined ? widthValue : firstValue(bounds, ["width", "Width"]), 0);
    var height = numberValue(heightValue !== undefined ? heightValue : firstValue(bounds, ["height", "Height"]), 0);
    var right = numberValue(rightValue !== undefined ? rightValue : firstValue(bounds, ["right", "Right"]), left + width);
    var bottom = numberValue(bottomValue !== undefined ? bottomValue : firstValue(bounds, ["bottom", "Bottom"]), top + height);

    if (!width && right > left) width = right - left;
    if (!height && bottom > top) height = bottom - top;

    return {
      name: sanitizeLayerName(firstValue(layer, ["name", "Name", "layerName", "LayerName"]), index),
      url: url ? resolveUrl(baseUrl, url) : "",
      base64: base64 ? String(base64).replace(/^data:image\/[^;]+;base64,/, "") : "",
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
      opacity: Math.max(0, Math.min(100, numberValue(firstValue(layer, ["opacity", "Opacity"]), 100)))
    };
  }

  function normalizeLayeredResult(payload, baseUrl) {
    var normalizedBaseUrl = normalizeBaseUrl(baseUrl || "http://localhost");
    var source = unwrapResponse(payload);
    var nested = unwrapResponse(source);
    var layers = firstValue(source, ["layers", "Layers", "LayerInfos", "layerInfos"]) ||
      firstValue(nested, ["layers", "Layers", "LayerInfos", "layerInfos"]);
    var urls = firstValue(source, ["urls", "Urls", "imageUrls", "ImageUrls"]) ||
      firstValue(nested, ["urls", "Urls", "imageUrls", "ImageUrls"]);
    var psdUrl = firstValue(source, ["psdUrl", "PsdUrl", "PSDUrl", "psd_url"]) ||
      firstValue(nested, ["psdUrl", "PsdUrl", "PSDUrl", "psd_url"]);

    if (!Array.isArray(layers) && Array.isArray(urls)) {
      layers = urls.map(function (url, index) {
        return { name: "AI 图层 " + (index + 1), url: url };
      });
    }
    if (!Array.isArray(layers)) layers = [];

    layers = layers.map(function (layer, index) {
      return normalizeLayerEntry(layer || {}, normalizedBaseUrl, index + 1);
    }).filter(function (layer) {
      return Boolean(layer.url || layer.base64);
    });

    if (!layers.length && !psdUrl) {
      throw new Error("平台生成完成，但没有返回 PSD 或透明 PNG 图层。请确认接口返回 psdUrl 或 layers。");
    }

    return {
      psdUrl: psdUrl ? resolveUrl(normalizedBaseUrl, psdUrl) : "",
      layers: layers
    };
  }

  function parseTraceId(payload, headers) {
    var response = unwrapResponse(payload);
    return firstValue(payload, ["trace_id", "traceId", "TraceId", "TraceID"]) ||
      firstValue(response, ["trace_id", "traceId", "TraceId", "TraceID"]) ||
      firstValue(headers || {}, ["x-trace-id", "X-Trace-ID", "x-traceid"]);
  }

  function taskStatus(payload) {
    var response = unwrapResponse(payload);
    var status = firstValue(payload, ["status", "Status", "state", "State"]) ||
      firstValue(response, ["status", "Status", "state", "State"]);
    return String(status || "").toLowerCase();
  }

  function taskError(payload) {
    var response = unwrapResponse(payload);
    var error = firstValue(payload, ["fail_reason", "last_retry_reason", "error", "Error", "message", "Message"]) ||
      firstValue(response, ["fail_reason", "last_retry_reason", "error", "Error", "message", "Message"]);
    if (error && typeof error === "object") {
      error = firstValue(error, ["message", "Message", "code", "Code"]);
    }
    return error ? String(error) : "任务生成失败。";
  }

  function isTerminalStatus(status) {
    var value = String(status || "").toLowerCase();
    return value === "done" || value === "fail" || value === "failed" || value === "timeout" || value === "canceled" || value === "cancelled";
  }

  function strictEncode(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return "%" + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function sha1(value) {
    return crypto.createHash("sha1").update(value).digest("hex");
  }

  function hmacSha1(key, value) {
    return crypto.createHmac("sha1", key).update(value).digest("hex");
  }

  function buildCosAuthorization(options) {
    var normalizedHeaders = {};
    Object.keys(options.headers || {}).forEach(function (name) {
      normalizedHeaders[String(name).toLowerCase()] = String(options.headers[name]).replace(/^\s+|\s+$/g, "");
    });

    var headerNames = Object.keys(normalizedHeaders).sort();
    var headerList = headerNames.map(function (name) { return strictEncode(name).toLowerCase(); }).join(";");
    var headerString = headerNames.map(function (name) {
      return strictEncode(name) + "=" + strictEncode(normalizedHeaders[name]);
    }).join("&");
    var keyTime = String(options.startTime) + ";" + String(options.endTime);
    var httpString = String(options.method || "GET").toLowerCase() + "\n" + options.pathname + "\n\n" + headerString + "\n";
    var signKey = hmacSha1(options.secretKey, keyTime);
    var stringToSign = "sha1\n" + keyTime + "\n" + sha1(httpString) + "\n";
    var signature = hmacSha1(signKey, stringToSign);

    return "q-sign-algorithm=sha1" +
      "&q-ak=" + strictEncode(options.secretId) +
      "&q-sign-time=" + keyTime +
      "&q-key-time=" + keyTime +
      "&q-header-list=" + headerList +
      "&q-url-param-list=" +
      "&q-signature=" + signature;
  }

  function sanitizeMessage(message) {
    return String(message || "请求失败。")
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer ***")
      .replace(/(SecretKey|SecretId|Token|api[_ -]?key)\s*[:=]\s*[^,;\s]+/gi, "$1=***");
  }

  function parseResponseHeaders(rawHeaders) {
    var headers = {};
    String(rawHeaders || "").replace(/\r?\n/g, "\n").split("\n").forEach(function (line) {
      var separator = line.indexOf(":");
      if (separator <= 0) return;
      headers[line.slice(0, separator).replace(/^\s+|\s+$/g, "").toLowerCase()] =
        line.slice(separator + 1).replace(/^\s+|\s+$/g, "");
    });
    return headers;
  }

  function transientStatus(status) {
    return [408, 429, 500, 502, 503, 504].indexOf(Number(status)) >= 0;
  }

  function transportError(message, code) {
    var error = new Error(sanitizeMessage(message));
    error.code = code || "NETWORK_ERROR";
    error.retryable = ["NETWORK_ERROR", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].indexOf(error.code) >= 0;
    return error;
  }

  function httpError(message, status) {
    var error = new Error(sanitizeMessage(message));
    error.statusCode = Number(status);
    error.retryable = transientStatus(status);
    return error;
  }

  function isRetryableError(error) {
    return !!(error && error.retryable && !error.platformFailed);
  }

  function browserRequestBuffer(requestUrl, options) {
    return new Promise(function (resolve, reject) {
      var request = new XMLHttpRequest();
      var body = options.body || null;
      request.open(options.method || "GET", requestUrl, true);
      request.responseType = "arraybuffer";
      request.timeout = options.timeout || 120000;
      Object.keys(options.headers || {}).forEach(function (name) {
        var lowerName = String(name).toLowerCase();
        if (lowerName === "host" || lowerName === "content-length" || lowerName === "connection") return;
        request.setRequestHeader(name, options.headers[name]);
      });
      request.onload = function () {
        var responseBytes = request.response ? new Uint8Array(request.response) : new Uint8Array(0);
        resolve({
          statusCode: request.status,
          headers: parseResponseHeaders(request.getAllResponseHeaders()),
          buffer: Buffer.from(responseBytes)
        });
      };
      request.onerror = function () {
        reject(transportError("浏览器网络请求失败，请确认 Photoshop 可以访问该平台。"));
      };
      request.ontimeout = function () {
        reject(transportError("网络请求超时。", "ETIMEDOUT"));
      };
      request.onabort = function () {
        reject(transportError("浏览器网络请求已中断。"));
      };
      if (Buffer.isBuffer(body)) {
        body = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      }
      request.send(body);
    });
  }

  function nodeRequestBuffer(requestUrl, options, redirectCount) {
    return new Promise(function (resolve, reject) {
      var parsed = nodeUrl.parse(requestUrl);
      var transport = parsed.protocol === "https:" ? https : http;
      var requestOptions = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        method: options.method || "GET",
        path: parsed.path,
        headers: options.headers || {},
        rejectUnauthorized: true
      };
      var request = transport.request(requestOptions, function (response) {
        var chunks = [];
        response.on("data", function (chunk) { chunks.push(chunk); });
        response.on("error", function (error) { reject(transportError(error.message, error.code)); });
        response.on("aborted", function () { reject(transportError("网络响应传输中断。", "ECONNRESET")); });
        response.on("end", function () {
          var buffer = Buffer.concat(chunks);
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && (redirectCount || 0) < 5) {
            resolve(nodeRequestBuffer(nodeUrl.resolve(requestUrl, response.headers.location), options, (redirectCount || 0) + 1));
            return;
          }
          resolve({ statusCode: response.statusCode, headers: response.headers, buffer: buffer });
        });
      });
      request.setTimeout(options.timeout || 120000, function () {
        request.destroy(transportError("网络请求超时。", "ETIMEDOUT"));
      });
      request.on("error", function (error) {
        reject(transportError(error.message, error.code));
      });
      if (options.body) request.write(options.body);
      request.end();
    });
  }

  function curlConfigValue(value) {
    var text = String(value === undefined || value === null ? "" : value);
    if (/\r|\n/.test(text)) throw new Error("请求参数包含非法换行。") ;
    return "\"" + text.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"") + "\"";
  }

  function removeCurlTempFiles(directory, files) {
    files.forEach(function (filePath) {
      try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (error) {}
    });
    try {
      if (directory && fs.existsSync(directory)) fs.rmdirSync(directory);
    } catch (error) {}
  }

  function curlRequestBuffer(requestUrl, options) {
    return new Promise(function (resolve, reject) {
      var tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ps-aigc-"));
      var configPath = path.join(tempDirectory, "request.cfg");
      var requestBodyPath = path.join(tempDirectory, "request.bin");
      var responseBodyPath = path.join(tempDirectory, "response.bin");
      var responseHeadersPath = path.join(tempDirectory, "response.headers");
      var tempFiles = [configPath, requestBodyPath, responseBodyPath, responseHeadersPath];
      var timeoutSeconds = Math.max(1, Math.ceil((options.timeout || 120000) / 1000));
      var configLines = [
        "url = " + curlConfigValue(requestUrl),
        "request = " + curlConfigValue(options.method || "GET"),
        "location",
        "max-redirs = 5",
        "silent",
        "show-error",
        "connect-timeout = 30",
        "max-time = " + timeoutSeconds,
        "dump-header = " + curlConfigValue(responseHeadersPath),
        "output = " + curlConfigValue(responseBodyPath),
        "write-out = " + curlConfigValue("%{http_code}")
      ];
      var body = options.body;
      var curlPath = path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "curl.exe");
      var stdoutChunks = [];
      var stderrChunks = [];
      var settled = false;
      var child;

      Object.keys(options.headers || {}).forEach(function (name) {
        configLines.push("header = " + curlConfigValue(name + ": " + options.headers[name]));
      });
      if (body !== undefined && body !== null) {
        if (!Buffer.isBuffer(body)) body = Buffer.from(body);
        fs.writeFileSync(requestBodyPath, body, { mode: 384 });
        configLines.push("data-binary = " + curlConfigValue("@" + requestBodyPath));
      }
      fs.writeFileSync(configPath, configLines.join("\r\n") + "\r\n", { encoding: "utf8", mode: 384 });

      function finish(error, response) {
        if (settled) return;
        settled = true;
        removeCurlTempFiles(tempDirectory, tempFiles);
        if (error) reject(error);
        else resolve(response);
      }

      try {
        child = childProcess.spawn(curlPath, ["--config", configPath], {
          shell: false,
          windowsHide: true
        });
      } catch (error) {
        finish(new Error("无法启动 Windows 系统网络组件：" + sanitizeMessage(error.message)));
        return;
      }

      child.stdout.on("data", function (chunk) { stdoutChunks.push(chunk); });
      child.stderr.on("data", function (chunk) { stderrChunks.push(chunk); });
      child.on("error", function (error) {
        finish(new Error("无法启动 Windows 系统网络组件：" + sanitizeMessage(error.message)));
      });
      child.on("close", function (exitCode) {
        var statusText;
        var statusMatch;
        var responseBuffer;
        var responseHeaders;
        var curlError;
        if (settled) return;
        if (exitCode !== 0) {
          curlError = Buffer.concat(stderrChunks).toString("utf8").replace(/^\s+|\s+$/g, "");
          var failure = new Error("Windows 系统网络请求失败：" + sanitizeMessage(curlError || ("curl 退出码 " + exitCode)));
          failure.curlCode = exitCode;
          failure.retryable = [5, 6, 7, 18, 28, 52, 55, 56, 92].indexOf(exitCode) >= 0;
          finish(failure);
          return;
        }
        statusText = Buffer.concat(stdoutChunks).toString("utf8");
        statusMatch = statusText.match(/(\d{3})\s*$/);
        if (!statusMatch) {
          finish(new Error("Windows 系统网络请求没有返回 HTTP 状态。"));
          return;
        }
        try {
          responseBuffer = fs.existsSync(responseBodyPath) ? fs.readFileSync(responseBodyPath) : Buffer.alloc(0);
          responseHeaders = fs.existsSync(responseHeadersPath) ? parseResponseHeaders(fs.readFileSync(responseHeadersPath, "utf8")) : {};
        } catch (error) {
          finish(new Error("读取 Windows 系统网络响应失败：" + sanitizeMessage(error.message)));
          return;
        }
        finish(null, {
          statusCode: Number(statusMatch[1]),
          headers: responseHeaders,
          buffer: responseBuffer
        });
      });
    });
  }

  function requestBuffer(requestUrl, options, redirectCount) {
    options = options || {};
    var method = String(options.method || "GET").toUpperCase();
    var safeRead = method === "GET" || method === "HEAD";
    var repeatable = safeRead || method === "PUT";
    var retryDelays = [2000, 5000, 10000];

    function send() {
      if (typeof XMLHttpRequest !== "undefined") {
        if (!repeatable && process.platform === "win32") return curlRequestBuffer(requestUrl, options);
        return browserRequestBuffer(requestUrl, options).catch(function (error) {
          if (!repeatable) throw error;
          return curlRequestBuffer(requestUrl, options);
        });
      }
      return nodeRequestBuffer(requestUrl, options, redirectCount).catch(function (error) {
        if (!repeatable) throw error;
        return curlRequestBuffer(requestUrl, options);
      });
    }

    function retry(attempt, error) {
      var delay = retryDelays[attempt];
      if (options.onRetry) options.onRetry(attempt + 1, delay, error);
      return new Promise(function (resolve) { setTimeout(resolve, delay); }).then(function () { return request(attempt + 1); });
    }

    function request(attempt) {
      return send().then(function (response) {
        if (safeRead && transientStatus(response.statusCode) && attempt < retryDelays.length) {
          return retry(attempt, httpError("平台暂时不可用（HTTP " + response.statusCode + "）。", response.statusCode));
        }
        return response;
      }, function (error) {
        if (safeRead && isRetryableError(error) && attempt < retryDelays.length) return retry(attempt, error);
        throw error;
      });
    }
    return request(0);
  }

  function parseJsonResponse(response) {
    var text = response.buffer.toString("utf8");
    var data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw httpError("平台返回 HTTP " + response.statusCode + "。", response.statusCode);
        }
        throw new Error("平台返回了无法解析的数据。");
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw httpError(taskError(data) || ("平台返回 HTTP " + response.statusCode + "。"), response.statusCode);
    }
    return { data: data, headers: response.headers };
  }

  function GatewayClient(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = String(options.apiKey || "").replace(/^\s+|\s+$/g, "");
    if (!this.apiKey) throw new Error("请输入 API Key。");
    this.endpoints = buildEndpoints(this.baseUrl);
  }

  GatewayClient.prototype.gatewayRequest = function (requestUrl, method, payload, onRetry) {
    var body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");
    var headers = {
      Authorization: "Bearer " + this.apiKey,
      Accept: "application/json"
    };
    if (body) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = body.length;
    }
    return requestBuffer(requestUrl, { method: method || "GET", headers: headers, body: body, onRetry: onRetry }).then(parseJsonResponse);
  };

  GatewayClient.prototype.fetchModels = function () {
    var client = this;
    function publicText(requestUrl) {
      return requestBuffer(requestUrl, { method: "GET", headers: { Accept: "text/html, application/javascript" } }).then(function (response) {
        if (response.statusCode < 200 || response.statusCode >= 300) throw new Error("读取平台生图配置失败（HTTP " + response.statusCode + "），请重新连接。");
        return response.buffer.toString("utf8");
      });
    }
    return client.gatewayRequest(client.endpoints.models, "GET").then(function (response) {
      if (!studioCatalog.authorizedImageIds(response.data).length) return [];
      return publicText(client.endpoints.studio).then(function (html) {
        return publicText(studioCatalog.findStudioScript(client.endpoints.studio, html));
      }).then(function (source) {
        return studioCatalog.parseStudioCatalog(source, response.data);
      });
    });
  };

  GatewayClient.prototype.applyUpload = function (filePath) {
    var extension = String(filePath).split(".").pop().toLowerCase() || "png";
    return this.gatewayRequest(this.endpoints.applyUpload, "POST", {
      MediaType: extension,
      MediaName: "photoshop-selection." + extension
    }).then(function (response) {
      return unwrapResponse(response.data);
    });
  };

  GatewayClient.prototype.uploadToCos = function (filePath, uploadInfo) {
    var bucket = firstValue(uploadInfo, ["StorageBucket", "storageBucket"]);
    var region = firstValue(uploadInfo, ["StorageRegion", "storageRegion"]);
    var mediaPath = firstValue(uploadInfo, ["MediaStoragePath", "mediaStoragePath", "MediaUploadPath", "mediaUploadPath"]);
    var certificate = firstValue(uploadInfo, ["TempCertificate", "tempCertificate"]) || {};
    var secretId = firstValue(certificate, ["SecretId", "secretId", "TmpSecretId"]);
    var secretKey = firstValue(certificate, ["SecretKey", "secretKey", "TmpSecretKey"]);
    var token = firstValue(certificate, ["Token", "token", "SessionToken"]);
    var expiredTime = Number(firstValue(certificate, ["ExpiredTime", "expiredTime", "Expiration"]));
    if (!bucket || !region || !mediaPath || !secretId || !secretKey || !token) {
      throw new Error("平台返回的上传凭据不完整。");
    }

    var fileBuffer = fs.readFileSync(filePath);
    var host = bucket + ".cos." + region + ".myqcloud.com";
    var pathname = "/" + String(mediaPath).replace(/^\/+/, "");
    var requestPath = encodeURI(pathname).replace(/#/g, "%23");
    var now = Math.floor(Date.now() / 1000);
    var startTime = now - 60;
    var endTime = expiredTime && expiredTime > now ? Math.min(expiredTime - 30, now + 3600) : now + 900;
    var signedHeaders = {
      host: host
    };
    var authorization = buildCosAuthorization({
      method: "PUT",
      pathname: pathname,
      headers: signedHeaders,
      secretId: secretId,
      secretKey: secretKey,
      startTime: startTime,
      endTime: endTime
    });
    var headers = {
      Authorization: authorization,
      "Content-Type": "image/png",
      "Content-Length": fileBuffer.length,
      Host: host,
      "x-cos-security-token": token
    };
    return requestBuffer("https://" + host + requestPath, { method: "PUT", headers: headers, body: fileBuffer }).then(function (response) {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        var cosText = response.buffer ? response.buffer.toString("utf8") : "";
        var cosCode = (cosText.match(/<Code>([^<]+)<\/Code>/) || [])[1];
        var cosMessage = (cosText.match(/<Message>([^<]+)<\/Message>/) || [])[1];
        throw new Error("参考图上传失败，COS 返回 HTTP " + response.statusCode +
          (cosCode ? "（" + cosCode + (cosMessage ? "：" + sanitizeMessage(cosMessage).slice(0, 120) : "") + "）" : "") + "。");
      }
      return uploadInfo;
    });
  };

  GatewayClient.prototype.commitUpload = function (uploadInfo) {
    var sessionKey = firstValue(uploadInfo, ["VodSessionKey", "vodSessionKey"]);
    if (!sessionKey) throw new Error("平台没有返回上传会话标识。");
    return this.gatewayRequest(this.endpoints.commitUpload, "POST", { VodSessionKey: sessionKey }).then(function (response) {
      var result = unwrapResponse(response.data);
      var mediaUrl = firstValue(result, ["MediaUrl", "mediaUrl", "Url", "url"]);
      if (!mediaUrl) throw new Error("上传完成，但平台没有返回参考图地址。");
      return mediaUrl;
    });
  };

  GatewayClient.prototype.uploadSelection = function (filePath) {
    var client = this;
    return client.applyUpload(filePath).then(function (uploadInfo) {
      return client.uploadToCos(filePath, uploadInfo);
    }).then(function (uploadInfo) {
      return client.commitUpload(uploadInfo);
    });
  };

  GatewayClient.prototype.createImage = function (options) {
    return this.gatewayRequest(this.endpoints.createImage, "POST", buildCreateImagePayload(options)).then(function (response) {
      var traceId = parseTraceId(response.data, response.headers);
      if (!traceId) throw new Error("任务已提交，但平台没有返回 trace_id。");
      return String(traceId);
    });
  };

  GatewayClient.prototype.createLayeredPsd = function (options) {
    return this.gatewayRequest(this.endpoints.createLayeredPsd, "POST", buildLayeredPsdPayload(options)).then(function (response) {
      var traceId = parseTraceId(response.data, response.headers);
      if (!traceId) throw new Error("分层任务已提交，但平台没有返回 trace_id。");
      return String(traceId);
    });
  };

  GatewayClient.prototype.getTask = function (traceId, onRetry) {
    var requestUrl = this.endpoints.taskDetail + "?trace_id=" + encodeURIComponent(traceId) + "&_ts=" + Date.now();
    return this.gatewayRequest(requestUrl, "GET", undefined, onRetry).then(function (response) {
      return response.data;
    });
  };

  GatewayClient.prototype.downloadResult = function (traceId, destinationPath, onRetry) {
    var requestUrl = this.endpoints.download + "?trace_id=" + encodeURIComponent(traceId) + "&index=0&proxy=1";
    var headers = { Authorization: "Bearer " + this.apiKey, Accept: "image/*" };
    return requestBuffer(requestUrl, { method: "GET", headers: headers, timeout: 180000, onRetry: onRetry }).then(function (response) {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw httpError("结果下载失败，平台返回 HTTP " + response.statusCode + "。", response.statusCode);
      }
      var contentType = String(response.headers["content-type"] || "").toLowerCase();
      var outputPath = destinationPath;
      if (contentType.indexOf("image/jpeg") >= 0) {
        outputPath = destinationPath.replace(/\.[^.]+$/, ".jpg");
      } else if (contentType.indexOf("image/webp") >= 0) {
        outputPath = destinationPath.replace(/\.[^.]+$/, ".webp");
      }
      fs.writeFileSync(outputPath, response.buffer);
      return outputPath;
    });
  };

  GatewayClient.prototype.downloadLayeredResult = function (taskPayload, destinationDirectory) {
    var client = this;
    var result = normalizeLayeredResult(taskPayload, this.baseUrl);
    var downloads = [];
    var psdPath = "";

    if (!fs.existsSync(destinationDirectory)) fs.mkdirSync(destinationDirectory);

    if (result.psdUrl) {
      psdPath = path.join(destinationDirectory, "ai-layered-result.psd");
      downloads.push(requestBuffer(result.psdUrl, { method: "GET", headers: { Authorization: "Bearer " + client.apiKey }, timeout: 180000 }).then(function (response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw httpError("PSD 下载失败，平台返回 HTTP " + response.statusCode + "。", response.statusCode);
        }
        fs.writeFileSync(psdPath, response.buffer);
      }));
    }

    result.layers.forEach(function (layer, index) {
      var extension = layer.url && /\.jpe?g(\?|#|$)/i.test(layer.url) ? ".jpg" : ".png";
      var filePath = path.join(destinationDirectory, ("layer-" + (index + 1) + extension));
      layer.path = filePath;
      if (layer.base64) {
        downloads.push(Promise.resolve().then(function () {
          fs.writeFileSync(filePath, Buffer.from(layer.base64, "base64"));
        }));
      } else {
        downloads.push(requestBuffer(layer.url, { method: "GET", headers: { Authorization: "Bearer " + client.apiKey }, timeout: 180000 }).then(function (response) {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw httpError("图层下载失败，平台返回 HTTP " + response.statusCode + "。", response.statusCode);
          }
          var contentType = String(response.headers["content-type"] || "").toLowerCase();
          if (contentType.indexOf("image/jpeg") >= 0 && !/\.jpe?g$/i.test(filePath)) {
            layer.path = filePath.replace(/\.[^.]+$/, ".jpg");
          }
          fs.writeFileSync(layer.path, response.buffer);
        }));
      }
    });

    return Promise.all(downloads).then(function () {
      return {
        psdPath: psdPath,
        layers: result.layers,
        psdUrl: result.psdUrl
      };
    });
  };

  return {
    GatewayClient: GatewayClient,
    buildCosAuthorization: buildCosAuthorization,
    buildCreateImagePayload: buildCreateImagePayload,
    buildLayeredPsdPayload: buildLayeredPsdPayload,
    buildEndpoints: buildEndpoints,
    isTerminalStatus: isTerminalStatus,
    isRetryableError: isRetryableError,
    normalizeBaseUrl: normalizeBaseUrl,
    normalizeImageModelConfigs: normalizeImageModelConfigs,
    normalizeImageModels: normalizeImageModels,
    normalizeLayeredResult: normalizeLayeredResult,
    normalizeModels: normalizeModels,
    parseTraceId: parseTraceId,
    parseStudioCatalog: studioCatalog.parseStudioCatalog,
    requestBuffer: requestBuffer,
    sanitizeMessage: sanitizeMessage,
    taskError: taskError,
    taskStatus: taskStatus
  };
}));
