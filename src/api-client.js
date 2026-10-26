function extractUrlFromMarkdown(input) {
  const markdownMatch = String(input || "").match(/\[[^\]]*\]\(([^)]+)\)/);
  return markdownMatch ? markdownMatch[1] : String(input || "");
}

function normalizeBaseUrl(url) {
  const parsedUrl = new URL(String(url || "").trim().replace(/\\&/g, "&"));
  return `${parsedUrl.protocol}//${parsedUrl.host}`;
}

function extractPlatformBaseUrl(input) {
  const rawUrl = extractUrlFromMarkdown(input).trim().replace(/\\&/g, "&");
  const parsedUrl = new URL(rawUrl);
  const targetUrl = parsedUrl.searchParams.get("lk_target_url") || parsedUrl.searchParams.get("target_url") || parsedUrl.searchParams.get("url");
  return targetUrl ? normalizeBaseUrl(targetUrl) : normalizeBaseUrl(rawUrl);
}

function buildPlatformEndpoints(baseUrl) {
  const normalizedBaseUrl = extractPlatformBaseUrl(baseUrl);
  const triggerBase = `${normalizedBaseUrl}/v1/api/trigger`;

  return {
    loginCheck: `${normalizedBaseUrl}/v1/api/feishu/check`,
    stage: `${triggerBase}/stage`,
    stageMessage: `${triggerBase}/stage_message`,
    imagine: `${triggerBase}/imagine`,
    status: `${triggerBase}/status`,
    files: `${triggerBase}/files`
  };
}

function resolveResultUrl(baseUrl, resultUrl) {
  return new URL(String(resultUrl || ""), `${extractPlatformBaseUrl(baseUrl)}/`).href;
}

function getResponseData(response) {
  return response && response.data !== undefined ? response.data : response;
}

async function parseJsonResponse(response, actionName) {
  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(`${actionName}返回的不是 JSON：${text.slice(0, 160)}`);
    }
  }

  if (!response.ok) {
    const source = getResponseData(data) || {};
    const message = source.message || source.error || source.detail || text || response.statusText;
    throw new Error(`${actionName}失败（HTTP ${response.status}）：${message}`);
  }

  return data;
}

async function requestJson(url, options = {}, fetchImpl = fetch) {
  const requestOptions = {
    method: options.method || "GET",
    credentials: "include",
    cache: "no-store"
  };

  if (options.body !== undefined) {
    requestOptions.headers = { "Content-Type": "application/json" };
    requestOptions.body = JSON.stringify(options.body);
  }

  const response = await fetchImpl(url, requestOptions);
  return parseJsonResponse(response, options.actionName || "平台请求");
}

function readField(response, fieldName) {
  const source = getResponseData(response) || {};
  return source[fieldName] !== undefined ? source[fieldName] : response && response[fieldName];
}

function buildNanoBananaPrompt({ prompt, imageUrls, resolution = "1k", aspectRatio = "原图比例" }) {
  const trimmedPrompt = String(prompt || "").trim();
  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);

  if (!trimmedPrompt) {
    throw new Error("请先填写提示词。");
  }

  if (!urls.length) {
    throw new Error("没有可提交的选区图片。");
  }

  return `GEM3.1|${trimmedPrompt}|${urls.join(",")}|${resolution}|${aspectRatio}`;
}

function buildImaginePayload({ prompt, imageUrl }) {
  return {
    prompt: buildNanoBananaPrompt({ prompt, imageUrls: [imageUrl] }),
    picurl: null,
    batch_count: 1
  };
}

function parseLoginResult(response) {
  const source = getResponseData(response) || {};
  const explicitState = source.logged_in ?? source.loggedIn ?? source.is_login ?? source.isLogin ?? source.login;
  const user = source.user || source.user_info || source.userInfo || response.user || null;

  return {
    loggedIn: explicitState === undefined ? Boolean(user) : Boolean(explicitState),
    user
  };
}

async function checkFeishuLogin({ baseUrl, fetchImpl = fetch }) {
  const endpoints = buildPlatformEndpoints(baseUrl);
  const response = await requestJson(endpoints.loginCheck, { actionName: "检查飞书登录" }, fetchImpl);
  return parseLoginResult(response);
}

async function stageSelection({ baseUrl, imageBlob, filename = "photoshop-selection.png", fetchImpl = fetch }) {
  if (!imageBlob) {
    throw new Error("没有读取到 Photoshop 选区图片。");
  }

  const formData = new FormData();
  formData.append("file", imageBlob, filename);
  const response = await fetchImpl(buildPlatformEndpoints(baseUrl).stage, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    body: formData
  });
  const data = await parseJsonResponse(response, "上传选区");
  const stagedName = readField(data, "staged_name");

  if (!stagedName) {
    throw new Error("上传选区成功，但平台没有返回 staged_name。");
  }

  return stagedName;
}

async function turnStagedFileIntoImageUrl({ baseUrl, stagedName, fetchImpl = fetch }) {
  const data = await requestJson(buildPlatformEndpoints(baseUrl).stageMessage, {
    method: "POST",
    body: { staged_name: stagedName },
    actionName: "转换选区图片"
  }, fetchImpl);
  const imageUrl = readField(data, "picurl");

  if (!imageUrl) {
    throw new Error("平台没有返回选区图片 URL。");
  }

  return resolveResultUrl(baseUrl, imageUrl);
}

async function submitImagine({ baseUrl, payload, fetchImpl = fetch }) {
  const data = await requestJson(buildPlatformEndpoints(baseUrl).imagine, {
    method: "POST",
    body: payload,
    actionName: "提交生成"
  }, fetchImpl);
  const triggerId = readField(data, "trigger_id");

  if (!triggerId) {
    throw new Error("平台没有返回 trigger_id。");
  }

  return triggerId;
}

function buildTriggerQuery(endpoint, triggerId, now) {
  return `${endpoint}?trigger_id=${encodeURIComponent(triggerId)}&_ts=${now()}`;
}

async function fetchTriggerStatus({ baseUrl, triggerId, now = Date.now, fetchImpl = fetch }) {
  const endpoint = buildTriggerQuery(buildPlatformEndpoints(baseUrl).status, triggerId, now);
  const data = await requestJson(endpoint, { actionName: "查询生成状态" }, fetchImpl);
  const status = readField(data, "status");

  if (!status) {
    throw new Error("平台没有返回生成状态。");
  }

  return String(status).toLowerCase();
}

async function fetchTriggerFiles({ baseUrl, triggerId, now = Date.now, fetchImpl = fetch }) {
  const endpoint = buildTriggerQuery(buildPlatformEndpoints(baseUrl).files, triggerId, now);
  const data = await requestJson(endpoint, { actionName: "获取生成结果" }, fetchImpl);
  const urls = readField(data, "urls");

  if (!Array.isArray(urls) || !urls.length) {
    throw new Error("平台生成完成，但没有返回结果图片。");
  }

  return urls.map((url) => resolveResultUrl(baseUrl, url));
}

module.exports = {
  buildImaginePayload,
  buildNanoBananaPrompt,
  buildPlatformEndpoints,
  checkFeishuLogin,
  extractPlatformBaseUrl,
  fetchTriggerFiles,
  fetchTriggerStatus,
  parseLoginResult,
  resolveResultUrl,
  stageSelection,
  submitImagine,
  turnStagedFileIntoImageUrl
};
