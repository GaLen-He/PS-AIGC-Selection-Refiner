var csInterface = new CSInterface();
var fs = require("fs");
var os = require("os");
var path = require("path");

var STORAGE_KEY = "ps-aigc-selection-refiner-gateway-settings";
var TASK_STORAGE_KEY = "ps-aigc-selection-refiner-pending-tasks-v1";
var DEFAULT_PLATFORM = "https://ai-gateway.kurogames.com";
var POLL_INTERVAL_MS = 2000;
var POLL_TIMEOUT_MS = 10 * 60 * 1000;
var gatewayClient = null;
var connected = false;
var imageModels = [];
var connecting = false;
var selectionJobs = 0;
var selectionCounter = 0;
var referenceImages = [];
var referenceLoading = false;
var layerBusy = false;
var lastLayerRun = null;
var hostQueue = Promise.resolve();
var backgroundBridge = null;
var backgroundReturn = null;
var LAYER_CONCURRENCY = 8;
var GUIDE_COLORS = ["#ff4d4f", "#40a9ff", "#73d13d", "#ffc53d", "#b37feb", "#36cfc9", "#ff85c0", "#ffa940"];
var GUIDE_MAX_SIZE = 768;
var guide = { docId: null, docName: "", source: null, image: null, width: 0, height: 0, masks: {}, tool: "brush", last: null, painting: false };
var imeCompositionActive = false;
var resumingTasks = {};
var volatilePendingTasks = [];
var taskOldestFirst = false;
var pendingCapacity = 0;
var MAX_PENDING_TASKS = 20;
var recoveryStore = null;
var recoveryStoreInitialized = false;
var recoveryTimer = null;
var recoveryClosing = false;
var RECOVERY_INTERVAL_MS = 30000;
window.addEventListener("beforeunload", function () {
  recoveryClosing = true;
  if (recoveryTimer !== null) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  if (backgroundBridge) backgroundBridge.close().catch(function () {});
});
function getElement(id) {
  return document.getElementById(id);
}

function isTextEditingTarget(target) {
  if (!target) return false;
  var tagName = String(target.tagName || "").toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable === true;
}

function isImeComposing(event) {
  return imeCompositionActive || !!(event && event.isComposing) || !!(event && (event.keyCode === 229 || event.which === 229));
}

function bindTextInputIme(target) {
  if (!isTextEditingTarget(target) || target.getAttribute("data-ime-bound") === "true") return;
  target.setAttribute("data-ime-bound", "true");
  target.addEventListener("compositionstart", function (event) {
    imeCompositionActive = true;
    event.stopPropagation();
  });
  target.addEventListener("compositionupdate", function (event) {
    event.stopPropagation();
  });
  target.addEventListener("compositionend", function (event) {
    imeCompositionActive = false;
    event.stopPropagation();
  });
  target.addEventListener("keydown", function (event) {
    event.stopPropagation();
  });
  target.addEventListener("keypress", function (event) {
    event.stopPropagation();
  });
  target.addEventListener("keyup", function (event) {
    event.stopPropagation();
  });
  target.addEventListener("blur", function () {
    imeCompositionActive = false;
  });
}

function enableTextInputIme() {
  var fields = document.querySelectorAll("input, textarea, [contenteditable='true']");
  Array.prototype.forEach.call(fields, bindTextInputIme);
  document.addEventListener("focusin", function (event) {
    bindTextInputIme(event.target);
  });
}

function safeError(error) {
  var message = error && error.message ? error.message : String(error || "操作失败。");
  return AIGCGateway.sanitizeMessage(message);
}

function setStatus(message, kind, targetId) {
  var status = getElement(targetId || "status");
  status.hidden = false;
  status.textContent = message;
  status.className = "status" + (kind ? " " + kind : "");
}

function setLayerStatus(message, kind) {
  setStatus(message, kind, "layerStatus");
}
function setConnected(value) {
  connected = value;
  getElement("generationPanel").hidden = !value;
  updateControls();
}

function updateControls() {
  var jobsRunning = selectionJobs > 0 || layerBusy;
  var hasRetry = !!(lastLayerRun && lastLayerRun.pendingCount > 0);
  getElement("platformUrl").disabled = connecting || jobsRunning;
  getElement("apiKey").disabled = connecting || jobsRunning;
  getElement("connectButton").disabled = connecting || jobsRunning;
  getElement("modelSelect").disabled = connecting;
  getElement("submitButton").disabled = connecting || !connected || referenceLoading;
  getElement("addReferenceButton").disabled = referenceLoading;
  getElement("referenceFileInput").disabled = referenceLoading;
  getElement("layeredButton").disabled = connecting || !connected || layerBusy;
  getElement("layerTemplate").disabled = layerBusy;
  getElement("layerList").disabled = layerBusy;
  getElement("guideButton").disabled = layerBusy;
  getElement("retryLayersButton").hidden = !hasRetry;
  getElement("retryLayersButton").disabled = connecting || !connected || layerBusy;
  var recoveryButton = getElement("recoverTasksButton");
  if (recoveryButton) {
    var pendingCount = loadPendingTasks().length;
    recoveryButton.hidden = !pendingCount;
    recoveryButton.disabled = connecting;
    recoveryButton.textContent = "继续取回";
  }
  renderTaskProgress();
}

function renderTaskProgress() {
  if (typeof document === "undefined" || typeof AIGCTaskProgress === "undefined") return;
  AIGCTaskProgress.render(document, loadPendingTasks(), retryPendingTasks, taskRunningMap(), {
    oldestFirst: taskOldestFirst, dismiss: dismissPendingTasks
  });
}

function taskRunningMap() {
  var running = Object.assign({}, resumingTasks);
  if (layerBusy) loadPendingTasks().forEach(function (task) { if (task.type === "layer") running[task.id] = true; });
  return running;
}

function setTaskPanelOpen(open) {
  getElement("taskProgressOverlay").hidden = !open;
  getElement("taskProgressButton").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderTaskProgress();
}

function setTaskPanelNotice(message, kind) {
  setStatus(message, kind);
  if (typeof document === "undefined") return;
  var notice = getElement("taskProgressNotice");
  if (!notice) return;
  notice.hidden = false;
  notice.textContent = message;
  notice.className = "status" + (kind ? " " + kind : "");
}

function dismissPendingTasks(taskId) {
  var tasks = loadPendingTasks();
  var removable = AIGCTaskProgress.removableIds(tasks, taskRunningMap()).filter(function (identity) { return !taskId || identity === taskId; });
  if (!removable.length || !window.confirm("清除 " + removable.length + " 个失败/暂停任务的追踪？\n不会删除缓存图片或 PSD 图层，也不会取消平台任务。清除后不再自动取回。")) return;
  try {
    tasks = loadPendingTasks();
    var eligible = AIGCTaskProgress.removableIds(tasks, taskRunningMap());
    removable = removable.filter(function (identity) { return eligible.indexOf(identity) >= 0; });
    savePendingTasks(tasks.filter(function (task) { return removable.indexOf(task.id) < 0; }));
    if (loadPendingTasks().some(function (task) { return removable.indexOf(task.id) >= 0; })) {
      throw new Error("任务存档未能清理，请检查配置目录权限；暂停任务仍保留。");
    }
    if (lastLayerRun && (lastLayerRun.taskIds || []).some(function (identity) { return removable.indexOf(identity) >= 0; })) lastLayerRun = null;
    updateControls();
  } catch (error) {
    setStatus(safeError(error), "error");
    renderTaskProgress();
  }
}

function reservePendingCapacity(count) {
  if (!Number.isInteger(count) || count < 1 || loadPendingTasks().length + pendingCapacity + count > MAX_PENDING_TASKS) {
    throw new Error("最多同时保留 20 个待取回任务，请先清除暂停任务或等待现有任务完成；本次未提交生图。");
  }
  pendingCapacity += count;
  return { remaining: count };
}

function releasePendingCapacity(reservation, count) {
  if (!reservation) return;
  var released = count === undefined ? reservation.remaining : Math.min(reservation.remaining, count);
  pendingCapacity -= released;
  reservation.remaining -= released;
}

function setBusy(isBusy) {
  connecting = isBusy;
  updateControls();
}

function keepPanelAlive() {
  try {
    csInterface.dispatchEvent({ type: "com.adobe.PhotoshopPersistent", scope: "APPLICATION",
      extensionId: csInterface.getExtensionID(), data: "" });
  } catch (error) {}
}

function getRecoveryStore() {
  if (recoveryStoreInitialized) return recoveryStore;
  recoveryStoreInitialized = true;
  if (typeof process === "undefined" || !process.env.APPDATA || !window.__adobe_cep__) return null;
  try {
    var host = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    var identity = String(host.appId || "PHXS") + "_" + String(host.appVersion || "unknown");
    identity = identity.replace(/[^a-z0-9_.-]/gi, "_");
    recoveryStore = require(path.join(csInterface.getExtensionPath(), "js", "recovery-state.js")).createStore(
      path.join(process.env.APPDATA, "Adobe", "AIGCSelectionRefiner", "recovery-state", identity));
  } catch (error) { recoveryStore = null; }
  return recoveryStore;
}

function readRecoveryState(name, fallback) {
  var store = getRecoveryStore();
  if (store) {
    try { return store.read(name, fallback); } catch (error) {}
  }
  return fallback;
}

function writeRecoveryState(name, value, storageKey) {
  var persisted = false;
  var store = getRecoveryStore();
  if (store) {
    try { store.write(name, value); persisted = true; } catch (error) {}
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(storageKey, JSON.stringify(value));
      persisted = true;
    }
  } catch (error) {}
  if (!persisted && (store || typeof localStorage !== "undefined")) throw new Error("任务存档写入失败，请检查用户配置目录权限和磁盘空间；不要重复提交。");
}

function loadSettings() {
  var settings = {};
  try {
    settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (error) {}
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  return readRecoveryState("settings", settings);
}

function loadPendingTasks() {
  var tasks;
  try {
    tasks = JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) || "[]");
  } catch (error) {
    tasks = volatilePendingTasks.slice();
  }
  return readRecoveryState("tasks", Array.isArray(tasks) ? tasks : []);
}

function savePendingTasks(tasks) {
  volatilePendingTasks = (tasks || []).slice();
  writeRecoveryState("tasks", tasks || [], TASK_STORAGE_KEY);
  renderTaskProgress();
}

function upsertPendingTask(task) {
  if (!task || !task.id) return;
  var tasks = loadPendingTasks();
  var replaced = false;
  tasks = tasks.map(function (current) {
    if (current.id !== task.id) return current;
    replaced = true;
    return task;
  });
  if (!replaced) tasks.push(task);
  savePendingTasks(tasks);
}

function removePendingTask(taskId) {
  savePendingTasks(loadPendingTasks().filter(function (task) { return task.id !== taskId; }));
}

function markTaskForRecovery(task, error) {
  if (!task || !task.traceId) return false;
  task.recoveryBlocked = !!(error && error.recoveryBlocked);
  task.lastRecoveryError = { message: safeError(error), phase: error && error.phase || task.stage,
    number: error && typeof error.number === "number" ? error.number : null,
    code: error && error.code || null, stripe: error && error.stripe, pixelInfo: error && error.pixelInfo || null,
    compatibilityError: error && error.compatibilityError ? safeError({ message: error.compatibilityError }) : "",
    compatibilityPhase: error && error.compatibilityPhase || "",
    rollbackError: error && error.rollbackError ? safeError({ message: error.rollbackError }) : "", at: Date.now() };
  task.recoveryMessage = "";
  var returning = task.stage === "placing";
  var recoverable = !task.recoveryBlocked && !(error && error.platformFailed) &&
    (returning || !!(error && error.backgroundUnavailable) || AIGCGateway.isRetryableError(error));
  task.recoveryAttempts = recoverable ? (task.recoveryAttempts || 0) + 1 : task.recoveryAttempts || 0;
  task.recoveryExhausted = returning && !(error && error.backgroundUnavailable) && task.recoveryAttempts >= 5;
  task.autoResume = recoverable && !task.recoveryExhausted;
  task.nextRecoveryAt = Date.now() + Math.min(RECOVERY_INTERVAL_MS * Math.pow(2, Math.max(0, task.recoveryAttempts - 1)), 300000);
  upsertPendingTask(task);
  return task.autoResume;
}

function taskCanAutoResume(task) {
  if (!task || !task.traceId || task.recoveryBlocked || task.recoveryExhausted) return false;
  if (task.autoResume !== false) return true;
  var source = task.type === "layer" ? task.exportInfo : task.context;
  var slot = task.type === "layer" ? task.slot : source && source.slot;
  return !task.lastRecoveryError && task.stage === "placing" && !!(slot && slot.reservationId &&
    source && source.source && source.source.backgroundSessionId);
}

function preparePendingRecovery() {
  loadPendingTasks().forEach(function (task) {
    if (!task || !task.id || !task.traceId || task.recoveryBlocked) return;
    task.autoResume = true;
    task.recoveryAttempts = 0;
    task.recoveryExhausted = false;
    task.nextRecoveryAt = 0;
    upsertPendingTask(task);
  });
}

function scheduleTaskRecovery(client) {
  if (recoveryClosing || recoveryTimer !== null || !client) return;
  var tasks = loadPendingTasks().filter(function (task) {
    return taskCanAutoResume(task) && !resumingTasks[task.id] && !(layerBusy && task.type === "layer");
  });
  if (!tasks.length) return;
  var due = Math.min.apply(null, tasks.map(function (task) { return task.nextRecoveryAt || Date.now() + RECOVERY_INTERVAL_MS; }));
  recoveryTimer = setTimeout(function () {
    recoveryTimer = null;
    if (recoveryClosing) return;
    return resumePendingTasks(gatewayClient || client, true);
  }, Math.max(1, due - Date.now()));
}

function networkRetryReporter(report) {
  return function (attempt, delay) {
    report("连接暂时中断，" + Math.ceil(delay / 1000) + " 秒后重试（" + attempt + "/3），无需重启或重复提交。", "working");
  };
}

function taskFailureMessage(error, task) {
  var detail = safeError(error) + (error && error.phase ? "（阶段：" + error.phase + "）" : "");
  if (error && error.compatibilityError) detail += "\n兼容写入 [" + (error.compatibilityPhase || "unknown") + "] " + safeError({ message: error.compatibilityError });
  if (error && error.rollbackError) detail += "\n回滚失败：" + safeError({ message: error.rollbackError });
  if (error && error.pixelInfo) {
    var info = error.pixelInfo;
    detail += "\n像素 " + info.width + "×" + info.height + " / " + (info.components === 3 ? "RGB" : "RGBA") +
      "；目标图层 " + info.layerId + "；位置 " + info.left + "," + info.top;
  }
  if (task && task.recoveryBlocked) return "原任务回贴条件已变化，已暂停以免错贴。结果已保留；原文档及预建结果层仍有效时可点击「继续取回」，重启 PS 或没有预建层的旧任务不能自动认领。\n" + detail +
    (task.result && task.result.path ? "\n保留图片：" + task.result.path : "");
  if (task && task.recoveryExhausted) return "回贴连续失败，已停止自动重试以免打断操作。结果已保留，点击「继续取回」可重试，无需重新生图。\n" + detail;
  if (error && error.backgroundUnavailable) return "后台助手暂未连接，任务和结果已保留；助手连接后会自动重试，不会切换你的文档。\n" + safeError(error);
  if (task && task.autoResume) return "任务和结果已保存，将自动继续取回，无需重启或重复提交。\n" + detail;
  return detail + (task && !(error && error.platformFailed) ? "\n任务已保存，点击「继续取回」重试，不会重新生图。" : "");
}

function reconcileTaskCache(task) {
  function exists(filePath) {
    try { return !!filePath && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0; }
    catch (error) { return false; }
  }
  if (task.result && exists(task.result.path)) return;
  var processedMissing = !!task.result;
  task.result = null;
  if (task.stage === "waiting") return;
  if (exists(task.downloadedPath)) {
    task.stage = "downloaded";
  } else if (task.type !== "layer" && !processedMissing && exists(task.resultPath) &&
    (task.stage === "restored" || task.stage === "prepared" || task.stage === "placing")) {
    task.stage = "restored";
  } else {
    task.downloadedPath = "";
    task.stage = "downloading";
    if (task.type !== "layer") task.resultPath = path.join(os.tmpdir(), "aigc-result-recovered-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".png");
  }
  if (!exists(task.croppedPath)) task.croppedPath = "";
  if (!exists(task.cleanupPath)) task.cleanupPath = "";
  upsertPendingTask(task);
}

function retryPendingTasks(taskId) {
  if (typeof taskId !== "string") taskId = "";
  var tasks = loadPendingTasks().filter(function (task) { return task && (!taskId || task.id === taskId); });
  var running = taskRunningMap();
  var eligible = tasks.filter(function (task) { return !running[task.id]; });
  if (recoveryClosing || !eligible.length) {
    setTaskPanelNotice(recoveryClosing ? "面板正在关闭，请重新打开后取回。" : tasks.length ? "任务正在取回，请稍候；不会重复执行。" : "该任务已完成或已清除。", "working");
    return Promise.resolve([]);
  }
  function hasLocalResult(task) {
    try { return !!(task.result && task.result.path && fs.statSync(task.result.path).isFile() && fs.statSync(task.result.path).size > 0); }
    catch (error) { return false; }
  }
  if (!gatewayClient) eligible = eligible.filter(hasLocalResult);
  if (!eligible.length) {
    setTaskPanelNotice("请先连接平台，再取回已生成的任务；不会重新提交生图。", "error");
    return Promise.resolve([]);
  }
  eligible.forEach(function (task) {
    task.recoveryAttempts = 0;
    task.recoveryExhausted = false;
    task.recoveryBlocked = false;
    task.nextRecoveryAt = 0;
    task.autoResume = true;
    task.lastRecoveryError = null;
    task.recoveryMessage = "正在重新取回…（不会重新生图）";
    upsertPendingTask(task);
  });
  setTaskPanelNotice("正在重新取回 " + eligible.length + " 个任务…" + (eligible.length < tasks.length ? "其他任务正在执行或需要连接平台。" : ""), "working");
  var identities = eligible.map(function (task) { return task.id; });
  return resumePendingTasks(gatewayClient || {}, true, identities, !gatewayClient).then(function (results) {
    var remaining = loadPendingTasks().filter(function (task) { return identities.indexOf(task.id) >= 0; });
    var failed = remaining.filter(function (task) { return !!task.lastRecoveryError; });
    if (failed.length) setTaskPanelNotice("取回失败，结果仍保留。\n" + taskFailureMessage(failed[0].lastRecoveryError, failed[0]), "error");
    else if (!remaining.length) setTaskPanelNotice("本次取回已结束，请查看原 PSD 的结果图层；已返回的任务自动移除。", "success");
    return results;
  }).catch(function (error) {
    setTaskPanelNotice("取回未能启动：" + safeError(error), "error");
    return [];
  });
}

function pendingTaskPathMap() {
  var protectedPaths = {};
  function protect(filePath) {
    if (!filePath) return;
    try { protectedPaths[path.resolve(filePath).toLowerCase()] = true; } catch (error) {}
  }
  loadPendingTasks().forEach(function (task) {
    var context = task.context || {};
    var exportInfo = task.exportInfo || {};
    protect(task.workDirectory);
    protect(task.resultPath);
    protect(task.downloadedPath);
    protect(task.cleanupPath);
    protect(task.croppedPath);
    protect(context.imagePath);
    protect(context.uploadPath);
    protect(context.selectionMaskPath);
    protect(exportInfo.imagePath);
    if (task.result) protect(task.result.path);
  });
  return protectedPaths;
}

function isPendingTaskPath(filePath, protectedPaths) {
  var resolved;
  var key;
  try { resolved = path.resolve(filePath).toLowerCase(); } catch (error) { return false; }
  if (protectedPaths[resolved]) return true;
  for (key in protectedPaths) {
    if (Object.prototype.hasOwnProperty.call(protectedPaths, key) && resolved.indexOf(key + path.sep) === 0) return true;
  }
  return false;
}

function saveSettings(saveConnection) {
  var previous = loadSettings();
  writeRecoveryState("settings", {
    platformUrl: saveConnection === true ? getElement("platformUrl").value : (previous.platformUrl || getElement("platformUrl").value),
    apiKey: saveConnection === true ? getElement("apiKey").value : (previous.apiKey || ""),
    model: getElement("modelSelect").value || previous.model || "",
    layerTemplate: getElement("layerTemplate").value,
    layerList: getElement("layerList").value,
    prompt: getElement("prompt").value,
    cleanupText: false,
    watermarkMargin: getElement("watermarkMargin").checked,
    watermarkAxis: getElement("watermarkAxis").value
  }, STORAGE_KEY);
}

var WATERMARK_MARGIN = 0.08;

function watermarkMargin() {
  if (!getElement("watermarkMargin").checked) return 0;
  return getElement("watermarkAxis").value === "horizontal" ? { x: WATERMARK_MARGIN, y: 0 } : { x: 0, y: WATERMARK_MARGIN };
}

function setConnectionPanelOpen(open) {
  getElement("connectionOverlay").hidden = !open;
  getElement("connectionSettingsButton").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) getElement("platformUrl").focus();
  else getElement("connectionSettingsButton").focus();
}

function initializeConnection(settings) {
  getElement("platformUrl").value = settings.platformUrl || DEFAULT_PLATFORM;
  getElement("apiKey").value = settings.apiKey || "";
  if (settings.platformUrl && settings.apiKey) {
    setConnectionPanelOpen(false);
    return connectPlatform();
  }
  setConnectionPanelOpen(true);
  return Promise.resolve();
}

function removeFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    return;
  }
}

function removeDirectory(directoryPath) {
  if (!directoryPath) return;
  try {
    if (!fs.existsSync(directoryPath)) return;
    fs.readdirSync(directoryPath).forEach(function (name) {
      removeFile(path.join(directoryPath, name));
    });
    fs.rmdirSync(directoryPath);
  } catch (error) {
    return;
  }
}

function cleanupStaleTempFiles() {
  var tempRoot = os.tmpdir();
  var cutoff = Date.now() - 60 * 60 * 1000;
  var protectedPaths = pendingTaskPathMap();
  try {
    fs.readdirSync(tempRoot).forEach(function (name) {
      var fullPath = path.join(tempRoot, name);
      var stat;
      if (!/^(aigc-selection-|aigc-source-|aigc-result-|aigc-layered-|ps-aigc-)/.test(name)) return;
      try {
        stat = fs.statSync(fullPath);
      } catch (error) {
        return;
      }
      if (isPendingTaskPath(fullPath, protectedPaths)) return;
      if (stat.mtimeMs > cutoff) return;
      if (stat.isDirectory()) removeDirectory(fullPath);
      else removeFile(fullPath);
    });
  } catch (error) {
    return;
  }
}

function evalHost(method, args) {
  return Promise.resolve().then(function () {
    if (method === "placeResult") {
      return getBackgroundReturn().selection({ documentId: args[3], selection: args[1], source: args[5], artboard: args[6], selectionMaskPath: args[8], slot: args[9] },
        { path: args[0] }, args[7]);
    }
    if (method === "placeLayeredResult") {
      return getBackgroundReturn().layers(args[0], { documentId: args[1], source: args[3], artboard: args[5] }, args[2], args[4]);
    }
    if (method === "exportDocument") {
      var bridge = getBackgroundBridge();
      var sessionId;
      return bridge.waitReady().then(function () {
        sessionId = bridge.sessionId();
        if (!sessionId) throw new Error("后台助手会话身份缺失，未提交生图。");
        return queueHost(method, args);
      }).then(function (exported) {
        if (bridge.sessionId() !== sessionId) throw new Error("导出期间助手会话已变化，请重新提交。");
        exported.source.backgroundSessionId = sessionId;
        return exported;
      });
    }
    return queueHost(method, args);
  });
}

function queueHost(method, args) {
  var run = function () {
    return evalHostNow(method, args);
  };
  var result = hostQueue.then(run, run);
  hostQueue = result.catch(function () {});
  return result;
}

function getBackgroundBridge() {
  if (backgroundBridge) return backgroundBridge;
  try {
    var extensionPath = csInterface.getExtensionPath();
    var dataRoot = process.env.APPDATA;
    if (!dataRoot) throw new Error("未找到 Windows 用户配置目录，请检查当前账户环境。");
    var config = JSON.parse(fs.readFileSync(path.join(dataRoot, "Adobe", "AIGCSelectionRefiner", "bridge-token.json"), "utf8").replace(/^\uFEFF/, ""));
    backgroundBridge = require(path.join(extensionPath, "js", "background-bridge.js")).createBridge({ secret: config.token,
      onReady: function () { if (!recoveryClosing && gatewayClient) resumePendingTasks(gatewayClient, true); } });
    return backgroundBridge;
  } catch (error) {
    if (error.code === "ENOENT") error = new Error("后台助手安装不完整，请完整解压并运行 0.5.30 安装脚本；不会切换文档回贴。");
    error.backgroundUnavailable = true;
    throw error;
  }
}

function getBackgroundReturn() {
  if (!backgroundReturn) backgroundReturn = require(path.join(csInterface.getExtensionPath(), "js", "background-return.js")).createReturn({
    bridge: getBackgroundBridge(), renderPixels: renderReturnPixels
  });
  return backgroundReturn;
}

function renderReturnPixels(filePath, target, mode) {
  return loadImageElement(filePath).then(function (image) {
    var canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    var drawing = canvas.getContext("2d");
    var scale = mode === "cover" ? Math.max(target.width / image.width, target.height / image.height) : Math.min(target.width / image.width, target.height / image.height);
    var width = image.width * scale;
    var height = image.height * scale;
    drawing.imageSmoothingQuality = "high";
    drawing.drawImage(image, (target.width - width) / 2, (target.height - height) / 2, width, height);
    var pixels = drawing.getImageData(0, 0, target.width, target.height).data;
    return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  });
}

function exportCapturedSelection(layerName, reservationId) {
  return exportPixelSubmission({ selection: true, reservation: { name: layerName, id: reservationId } });
}

function exportPixelSubmission(options) {
  var bridge = getBackgroundBridge();
  var sessionId = bridge.sessionId();
  if (!sessionId) return Promise.reject(new Error("后台助手尚未连接，未提交生图。"));
  var base = path.join(os.tmpdir(), "aigc-selection-" + require('crypto').randomBytes(16).toString('hex'));
  var pixelsPath = base + ".rgba";
  var imagePath = base + ".png";
  var exported;
  return evalHost("prepareSubmission", [options]).then(function (context) {
    exported = context;
    if (bridge.sessionId() !== sessionId) throw new Error("取图期间助手会话已变化，未提交生图。");
    if (options.reservation) {
      var slots = options.reservation.names ? exported.slots : [exported.slot];
      var names = options.reservation.names || [options.reservation.name];
      if (!slots || slots.length !== names.length || slots.some(function (slot, index) {
        return !slot || !slot.layerId || slot.reservationId !== options.reservation.id || slot.name !== names[index] ||
          options.selection && !slot.maskPrepared;
      })) throw new Error("原选区目标图层或蒙版未准备好，未提交生图。");
    }
    exported.source.backgroundSessionId = sessionId;
    return bridge.snapshot(exported, pixelsPath);
  }).then(function (snapshot) {
    if (bridge.sessionId() !== sessionId) throw new Error("取图期间助手会话已变化，未提交生图。");
    exported.timing = Object.assign(exported.timing || {}, snapshot.timing);
    return preparePixelSnapshot(snapshot, exported, imagePath);
  }).then(function () {
    exported.imagePath = imagePath;
    exported.imagePreparation = null;
    console.info("AIGC submission timing", exported.timing);
    return exported;
  }).catch(function (error) { removeFile(imagePath); throw error; })
    .then(function (result) { removeFile(pixelsPath); return result; }, function (error) { removeFile(pixelsPath); throw error; });
}

function preparePixelSnapshot(snapshot, exported, outputPath) {
  return Promise.resolve().then(function () {
    var bytes = fs.readFileSync(snapshot.path);
    if (bytes.length !== snapshot.width * snapshot.height * 4) throw new Error("图像像素缓存不完整。");
    var pixels = document.createElement("canvas");
    pixels.width = snapshot.width;
    pixels.height = snapshot.height;
    var pixelContext = pixels.getContext("2d");
    var image = pixelContext.createImageData(pixels.width, pixels.height);
    image.data.set(bytes);
    pixelContext.putImageData(image, 0, 0);
    var target = exported.selection || exported.source;
    var bounds = snapshot.bounds;
    if (!bounds || ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error("图像快照边界无效，已停止提交以避免错位。");
    }
    var scale = Math.min(1, 2048 / Math.max(target.width, target.height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(target.width * scale));
    canvas.height = Math.max(1, Math.round(target.height * scale));
    var drawing = canvas.getContext("2d");
    drawing.fillStyle = "#ffffff";
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.imageSmoothingQuality = "high";
    drawing.drawImage(pixels, (bounds.left - target.left) * canvas.width / target.width,
      (bounds.top - target.top) * canvas.height / target.height,
      bounds.width * canvas.width / target.width, bounds.height * canvas.height / target.height);
    return writeCanvasPng(canvas, outputPath);
  });
}

function evalHostNow(method, args) {
  return new Promise(function (resolve, reject) {    var expression = "AIGCSelectionRefiner." + method + "(" + (args || []).map(function (value) {
      return JSON.stringify(value);
    }).join(",") + ")";
    csInterface.evalScript(expression, function (rawResult) {
      if (!rawResult || rawResult === "EvalScript error.") {
        reject(new Error("Photoshop 没有响应插件命令。"));
        return;
      }
      var result;
      try {
        result = JSON.parse(rawResult);
      } catch (error) {
        reject(new Error("Photoshop 返回异常（" + method + "）：" + String(rawResult).slice(0, 120)));
        return;
      }
      if (!result || !result.ok) {
        reject(new Error((result && result.error) || "Photoshop 操作失败。"));
        return;
      }
      resolve(result.data);
    });
  });
}

function populateModels(models, preferredModel) {
  var select = getElement("modelSelect");
  imageModels = models || [];
  select.innerHTML = "";
  imageModels.forEach(function (model) {
    var option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name;
    if (model.id === preferredModel) option.selected = true;
    select.appendChild(option);
  });
  getElement("modelSelectRow").hidden = imageModels.length === 0;
  renderSelectedModel();
}

function getSelectedModel() {
  var selectedId = getElement("modelSelect").value;
  var index;
  for (index = 0; index < imageModels.length; index += 1) {
    if (imageModels[index].id === selectedId) return imageModels[index];
  }
  return null;
}

function createParameterControl(parameter) {
  var field = document.createElement("label");
  var input;
  var option;
  var optionValue;

  field.className = parameter.type === "boolean" ? "parameterField checkboxField" : "parameterField";
  field.appendChild(document.createTextNode(parameter.label));

  if (parameter.type === "select") {
    input = document.createElement("select");
    if (parameter.name === "AspectRatio") {
      option = document.createElement("option");
      option.value = AIGCSelectionFrame.ORIGINAL;
      option.textContent = "原图比例（选区）";
      option.selected = true;
      input.appendChild(option);
    }
    parameter.options.forEach(function (item) {
      option = document.createElement("option");
      optionValue = item && typeof item === "object" ? (item.value !== undefined ? item.value : item.id) : item;
      option.value = String(optionValue === undefined ? "" : optionValue);
      option.textContent = String(item && typeof item === "object" ? (item.label || item.name || option.value) : item);
      if (parameter.name !== "AspectRatio" && String(parameter.default) === option.value) option.selected = true;
      input.appendChild(option);
    });
  } else {
    input = document.createElement("input");
    if (parameter.type === "boolean") {
      input.type = "checkbox";
      input.checked = parameter.default === true || parameter.default === 1 || parameter.default === "true";
    } else if (parameter.type === "number" || parameter.type === "integer") {
      input.type = "number";
      if (parameter.min !== undefined) input.min = parameter.min;
      if (parameter.max !== undefined) input.max = parameter.max;
      input.step = parameter.type === "integer" ? 1 : (parameter.step !== undefined ? parameter.step : "any");
      if (parameter.default !== undefined) input.value = parameter.default;
    } else {
      input.type = "text";
      if (parameter.default !== undefined) input.value = parameter.default;
    }
  }

  input.setAttribute("data-parameter-name", parameter.name);
  input.setAttribute("data-parameter-type", parameter.type);
  field.appendChild(input);
  return field;
}

function renderSelectedModel() {
  var model = getSelectedModel();
  var panel = getElement("parametersPanel");
  getElement("modelDescription").textContent = model ? model.description : "";
  panel.innerHTML = "";
  if (!model) {
    panel.hidden = true;
    return;
  }
  model.parameters.forEach(function (parameter) {
    panel.appendChild(createParameterControl(parameter));
  });
  if (!findModelParameter(model, "AspectRatio")) {
    panel.appendChild(createParameterControl({ name: "AspectRatio", label: "画面比例", type: "select", options: [] }));
  }
  panel.hidden = false;
}

function readParameterValues() {
  var values = {};
  var controls = getElement("parametersPanel").querySelectorAll("[data-parameter-name]");
  Array.prototype.forEach.call(controls, function (control) {
    var name = control.getAttribute("data-parameter-name");
    var type = control.getAttribute("data-parameter-type");
    if (type === "boolean") {
      values[name] = control.checked;
    } else if (type === "number" || type === "integer") {
      if (control.value !== "") values[name] = type === "integer" ? parseInt(control.value, 10) : Number(control.value);
    } else {
      values[name] = control.value;
    }
  });
  return values;
}

function getSelectedModelKey() {
  var value = getElement("modelSelect").value;
  return String(value || "").replace(/^\s+|\s+$/g, "");
}

function connectPlatform() {
  if (connecting || selectionJobs > 0 || layerBusy) return Promise.resolve();
  var baseUrl = getElement("platformUrl").value;
  var apiKey = getElement("apiKey").value;
  var settings = loadSettings();

  setConnected(false);
  setBusy(true);
  getElement("connectionState").textContent = "连接中…";
  setStatus("正在连接平台并读取模型…", "working");

  try {
    gatewayClient = new AIGCGateway.GatewayClient({ baseUrl: baseUrl, apiKey: apiKey });
    saveSettings(true);
    setConnectionPanelOpen(false);
  } catch (error) {
    setBusy(false);
    getElement("connectionState").textContent = "未连接";
    setConnectionPanelOpen(true);
    setStatus(safeError(error), "error");
    return Promise.resolve();
  }

  var recoveryClient = gatewayClient;
  var recovering = resumePendingTasks(recoveryClient);
  return recoveryClient.fetchModels().then(function (models) {
    populateModels(models, settings.model);
    saveSettings();
    if (!models.length) {
      setConnected(false);
      getElement("connectionState").textContent = "无生图权限";
      setStatus("此 Key 的授权列表中没有生图模型，请在平台检查模型权限。", "error");
      return;
    }
    setConnected(true);
    getElement("connectionState").textContent = "已连接 · " + models.length + " 个模型";
    setStatus("连接成功，已读取 " + models.length + " 个生图模型。", "success");
  }).catch(function (error) {
    setConnected(false);
    getElement("connectionState").textContent = "连接失败";
    setStatus("连接失败：" + safeError(error), "error");
  }).then(function () {
    setBusy(false);
    return recovering;
  });
}

function waitForTask(client, traceId, startedAt, onProgress) {
  if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
    var timeout = new Error("生成等待超过 10 分钟，稍后继续查询已提交的任务。");
    timeout.retryable = true;
    return Promise.reject(timeout);
  }

  return client.getTask(traceId, function (attempt, delay) {
    if (onProgress) onProgress("network-retry", attempt, delay);
  }).then(function (task) {
    var status = AIGCGateway.taskStatus(task);
    if (status === "done") return task;
    if (AIGCGateway.isTerminalStatus(status)) {
      var failure = new Error(AIGCGateway.taskError(task));
      failure.platformFailed = true;
      throw failure;
    }
    if (onProgress) onProgress(status);
    return new Promise(function (resolve) {
      setTimeout(resolve, POLL_INTERVAL_MS);
    }).then(function () {
      return waitForTask(client, traceId, startedAt, onProgress);
    });
  });
}

function moveReferenceImage(index, direction) {
  var target = index + direction;
  if (referenceLoading || index < 0 || target < 0 || index >= referenceImages.length || target >= referenceImages.length) return;
  var item = referenceImages.splice(index, 1)[0];
  referenceImages.splice(target, 0, item);
  renderReferenceImages();
}

function removeReferenceImage(index) {
  if (referenceLoading || index < 0 || index >= referenceImages.length) return;
  referenceImages.splice(index, 1);
  renderReferenceImages();
}

function renderReferenceImages() {
  var list = getElement("referenceList");
  list.innerHTML = "";
  list.hidden = !referenceImages.length;
  getElement("referenceCount").textContent = "（" + (referenceImages.length + 1) + "张）";
  referenceImages.forEach(function (item, index) {
    var row = document.createElement("div");
    var image = document.createElement("img");
    var caption = document.createElement("div");
    var number = document.createElement("strong");
    var name = document.createElement("span");
    var actions = document.createElement("div");
    row.className = "referenceItem";
    image.src = item.preview;
    image.alt = "图" + (index + 2) + "：" + item.name;
    caption.className = "referenceCaption";
    number.textContent = "图" + (index + 2);
    name.textContent = item.name;
    name.title = item.name + "（" + item.width + " × " + item.height + "）";
    caption.appendChild(number);
    caption.appendChild(name);
    actions.className = "referenceActions";
    [
      { text: "↑", title: "前移图" + (index + 2), disabled: index === 0, run: function () { moveReferenceImage(index, -1); } },
      { text: "↓", title: "后移图" + (index + 2), disabled: index === referenceImages.length - 1, run: function () { moveReferenceImage(index, 1); } },
      { text: "×", title: "移除图" + (index + 2), run: function () { removeReferenceImage(index); } }
    ].forEach(function (action) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = action.text;
      button.title = action.title;
      button.setAttribute("aria-label", action.title);
      button.disabled = referenceLoading || !!action.disabled;
      button.addEventListener("click", action.run);
      actions.appendChild(button);
    });
    row.appendChild(image);
    row.appendChild(caption);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function readReferenceFile(file) {
  return new Promise(function (resolve, reject) {
    if (!file || !/\.(png|jpe?g|webp)$/i.test(file.name) || (file.type && !/^image\/(png|jpeg|webp)$/i.test(file.type))) {
      reject(new Error("请选择 PNG、JPG 或 WebP 参考图。"));
      return;
    }
    if (!file.size || file.size > 20 * 1024 * 1024) {
      reject(new Error(file.name + "：图片为空或超过 20 MB，请先缩小。"));
      return;
    }
    var reader = new FileReader();
    reader.onerror = reader.onabort = function () { reject(new Error(file.name + "：文件读取失败。")); };
    reader.onload = function () {
      var image = new Image();
      image.onerror = function () { reject(new Error(file.name + "：图片无法解码，请另存为 PNG 或 JPG。")); };
      image.onload = function () {
        try {
          var width = image.naturalWidth || image.width;
          var height = image.naturalHeight || image.height;
          if (!width || !height || width > 8192 || height > 8192 || width * height > 32000000) {
            throw new Error(file.name + "：图片尺寸过大，请缩小至最长边 8192 像素以内、总计 3200 万像素以内。");
          }
          var png = canvasFromImage(image, width, height).toDataURL("image/png");
          if (png.indexOf("data:image/png;base64,") !== 0) throw new Error(file.name + "：PNG 转换失败。");
          var buffer = Buffer.from(png.slice(png.indexOf(",") + 1), "base64");
          if (buffer.length > 20 * 1024 * 1024) throw new Error(file.name + "：转换后超过 20 MB，请缩小图片。");
          var scale = Math.min(1, 96 / width, 84 / height);
          var preview = canvasFromImage(image, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))).toDataURL("image/png");
          resolve({ name: file.name, buffer: buffer, preview: preview, width: width, height: height });
        } catch (error) {
          reject(error);
        }
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function addReferenceFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []);
  if (referenceLoading || !files.length) return Promise.resolve();
  var errors = [];
  referenceLoading = true;
  updateControls();
  renderReferenceImages();
  setStatus("正在读取参考图…", "working", "referenceStatus");
  var chain = Promise.resolve();
  files.forEach(function (file) {
    chain = chain.then(function () {
      return readReferenceFile(file).then(function (item) {
        var totalBytes = referenceImages.reduce(function (total, reference) { return total + reference.buffer.length; }, item.buffer.length);
        if (totalBytes > 64 * 1024 * 1024) throw new Error(file.name + "：参考图总大小超过 64 MB，请移除部分图片。");
        referenceImages.push(item);
      }).catch(function (error) { errors.push(file.name + "：" + safeError(error)); });
    });
  });
  return chain.then(function () {
    referenceLoading = false;
    updateControls();
    renderReferenceImages();
    if (errors.length) setStatus(errors.join("\n"), "error", "referenceStatus");
    else getElement("referenceStatus").hidden = true;
  });
}

function uploadReferenceImages(client, references, report) {
  if (!references.length) return Promise.resolve([]);
  var directory;
  var urls = [];
  return Promise.resolve().then(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps-aigc-references-"));
    var chain = Promise.resolve();
    references.forEach(function (item, index) {
      chain = chain.then(function () {
        var filePath = path.join(directory, "reference-" + (index + 2) + ".png");
        report("正在上传图" + (index + 2) + "/" + (references.length + 1) + "…", "working");
        fs.writeFileSync(filePath, item.buffer);
        return client.uploadSelection(filePath).then(function (url) {
          if (typeof url !== "string" || !url.replace(/^\s+|\s+$/g, "")) throw new Error("图" + (index + 2) + "未返回上传地址。");
          urls.push(url);
          removeFile(filePath);
        });
      });
    });
    return chain;
  }).then(function () {
    removeDirectory(directory);
    return urls;
  }, function (error) {
    removeDirectory(directory);
    throw error;
  });
}

function bindReferencePaste() {
  var region = getElement("referenceBox");
  var hovered = false;
  region.addEventListener("mouseenter", function () { hovered = true; });
  region.addEventListener("mouseleave", function () { hovered = false; });
  window.addEventListener("blur", function () { hovered = false; });
  document.addEventListener("paste", function (event) {
    if (!connected || !getElement("connectionOverlay").hidden || (!hovered && !region.contains(document.activeElement))) return;
    var clipboard = event.clipboardData;
    if (!clipboard) return;
    var files = [];
    Array.prototype.forEach.call(clipboard.items || [], function (item) {
      if (item.kind !== "file" || !/^image\//i.test(item.type)) return;
      var file = item.getAsFile();
      if (file) files.push(file);
    });
    if (!files.length) {
      Array.prototype.forEach.call(clipboard.files || [], function (file) {
        if (/^image\//i.test(file.type)) files.push(file);
      });
    }
    if (!files.length) return;
    event.preventDefault();
    return addReferenceFiles(files);
  });
}

function prepareExportedImage(exported) {
  var preparation = exported.imagePreparation;
  if (!preparation) return Promise.resolve(exported);
  var inputPath = exported.imagePath;
  var outputPath = "";
  var copyExport = preparation.method === "copy";
  return Promise.resolve().then(function () {
    return loadImageElement(inputPath);
  }).then(function (image) {
    var crop = preparation.crop;
    var canvasBounds = preparation.canvas;
    if (!crop || !canvasBounds || image.width !== canvasBounds.width || image.height !== canvasBounds.height ||
        !(crop.width > 0 && crop.height > 0) || crop.left < 0 || crop.top < 0 ||
        crop.left + crop.width > image.width || crop.top + crop.height > image.height) {
      if (copyExport) return null;
      throw new Error("导出图片尺寸与原 PSD 不一致，已停止提交以避免选区错位。");
    }
    var scale = Math.min(1, (Number(preparation.maxSize) || 2048) / Math.max(crop.width, crop.height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(crop.width * scale));
    canvas.height = Math.max(1, Math.round(crop.height * scale));
    var drawing = canvas.getContext("2d");
    drawing.imageSmoothingQuality = "high";
    if (copyExport) {
      drawing.fillStyle = "#ffffff";
      drawing.fillRect(0, 0, canvas.width, canvas.height);
    }
    drawing.drawImage(image, crop.left, crop.top, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    outputPath = inputPath.replace(/\.png$/i, "-prepared.png");
    if (outputPath === inputPath) throw new Error("导出临时文件格式无效。");
    writeCanvasPng(canvas, outputPath);
    removeFile(inputPath);
    exported.imagePath = outputPath;
    delete exported.imagePreparation;
    return exported;
  }, function (error) {
    if (copyExport) return null;
    throw error;
  }).then(function (prepared) {
    if (prepared) return prepared;
    removeFile(inputPath);
    return evalHost("exportCompatibleImage", [exported.documentId, preparation.fallbackSelection || null]).then(function (result) {
      exported.imagePath = result.imagePath;
      delete exported.imagePreparation;
      return exported;
    });
  }).catch(function (error) {
    removeFile(inputPath);
    if (outputPath && outputPath !== inputPath) removeFile(outputPath);
    throw error;
  });
}

function prepareSelectionUpload(context, model, parameters) {
  var selection = context.selection || {};
  var resolved = AIGCSelectionFrame.resolve(parameters, findModelParameter(model, "AspectRatio"), selection.width, selection.height, watermarkMargin());
  context.generationFrame = resolved.frame;
  context.generationParameters = resolved.parameters;
  if (!resolved.frame) return Promise.resolve(context.imagePath);
  context.uploadPath = context.imagePath.replace(/\.png$/i, "-frame.png");
  if (context.uploadPath === context.imagePath) return Promise.reject(new Error("选区临时文件格式无效。"));
  return writeFramedImage(context.imagePath, context.uploadPath, resolved.frame);
}

function writeFramedImage(inputPath, outputPath, frame) {
  return loadImageElement(inputPath).then(function (image) {
    var canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    var drawing = canvas.getContext("2d");
    drawing.fillStyle = "#808080";
    drawing.fillRect(0, 0, frame.width, frame.height);
    drawing.imageSmoothingQuality = "high";
    drawing.drawImage(image, frame.left, frame.top, frame.contentWidth, frame.contentHeight);
    return writeCanvasPng(canvas, outputPath);
  });
}

function restoreSelectionFrame(inputPath, outputPath, frame) {
  if (!frame) return Promise.resolve(inputPath);
  return loadImageElement(inputPath).then(function (image) {
    var crop = AIGCSelectionFrame.crop(frame, image.width, image.height);
    if (frame.padded) crop = AIGCSelectionFrame.snapInside(crop);
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(crop.width));
    canvas.height = Math.max(1, Math.round(crop.height));
    var drawing = canvas.getContext("2d");
    drawing.imageSmoothingQuality = "high";
    var scale = Math.max(canvas.width / crop.width, canvas.height / crop.height);
    drawing.drawImage(image, crop.left, crop.top, crop.width, crop.height,
      (canvas.width - crop.width * scale) / 2, (canvas.height - crop.height * scale) / 2, crop.width * scale, crop.height * scale);
    return writeCanvasPng(canvas, outputPath);
  });
}

function selectionTaskId(traceId) {
  return "selection:" + String(traceId || "");
}

function layerTaskId(traceId) {
  return "layer:" + String(traceId || "");
}

function layerTaskFromRun(run, index, stage, extra) {
  var job = run.jobs[index];
  run.taskIds = run.taskIds || [];
  run.taskCreatedAt = run.taskCreatedAt || [];
  run.downloadedPaths = run.downloadedPaths || [];
  var task = {
    id: run.taskIds[index] || layerTaskId(run.traces[index]),
    type: "layer",
    traceId: run.traces[index],
    stage: stage,
    autoResume: true,
    createdAt: run.taskCreatedAt[index] || Date.now(),
    updatedAt: Date.now(),
    index: index,
    job: { name: job.name, kind: job.kind },
    groupName: run.groupName,
    layerOrder: run.jobs.map(function (item) { return item.name; }),
    exportInfo: {
      documentId: run.exportInfo.documentId,
      documentName: run.exportInfo.documentName,
      source: run.exportInfo.source,
      artboard: run.exportInfo.artboard
    },
    workDirectory: run.workDirectory,
    cleanupText: run.cleanupText,
    slot: run.slots && run.slots[index],
    target: run.targets && run.targets[index] || run.exportInfo.source,
    sourceFrame: !(run.targets && run.targets[index]) ? run.sourceFrame : null,
    downloadedPath: run.downloadedPaths[index] || "",
    result: run.results[index] || null
  };
  var key;
  run.taskIds[index] = task.id;
  run.taskCreatedAt[index] = task.createdAt;
  if (extra) {
    for (key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) task[key] = extra[key];
    }
  }
  upsertPendingTask(task);
  return task;
}

function processSelectionPendingTask(task, client, report) {
  reconcileTaskCache(task);
  var context = task.context || {};
  var resultPath = task.result && task.result.path || task.resultPath;
  var downloadedPath = task.downloadedPath || "";
  var cleanupWarning = task.cleanupWarning || "";
  var croppedPath = task.croppedPath || "";
  var cleanupPath = task.cleanupPath || "";
  var transparentRequested = String(context.generationParameters && context.generationParameters.Background || "").toLowerCase() === "transparent";
  upsertPendingTask(task);

  function persist(stage) {
    task.stage = stage;
    task.updatedAt = Date.now();
    upsertPendingTask(task);
  }

  return Promise.resolve().then(function () {
    if (task.result && task.result.path) return;
    if (task.stage !== "waiting") return;
    report("平台正在生成…（关闭面板后也会继续追踪）", "working");
    return waitForTask(client, task.traceId, Date.now(), function (status, attempt, delay) {
      if (status === "network-retry") networkRetryReporter(report)(attempt, delay);
      if (status === "transferring") report("生成完成，正在转存结果…", "working");
    }).then(function () { persist("downloading"); });
  }).then(function () {
    if (task.result && task.result.path) return;
    if (task.stage !== "downloading" || downloadedPath) return;
    report("正在下载结果…", "working");
    return client.downloadResult(task.traceId, task.resultPath, networkRetryReporter(report)).then(function (filePath) {
      downloadedPath = filePath;
      task.downloadedPath = filePath;
      persist("downloaded");
    });
  }).then(function () {
    if (task.result && task.result.path) return;
    if (!downloadedPath) downloadedPath = task.downloadedPath || task.resultPath;
    if (task.stage !== "downloaded") return;
    croppedPath = task.croppedPath || path.join(os.tmpdir(), "aigc-result-crop-resume-" + Date.now() + ".png");
    task.croppedPath = croppedPath;
    return restoreSelectionFrame(downloadedPath, croppedPath, context.generationFrame).then(function (restoredPath) {
      resultPath = restoredPath;
      task.resultPath = restoredPath;
      persist("restored");
    });
  }).then(function () {
    if (task.result && task.result.path) return;
    resultPath = task.resultPath || downloadedPath;
    if (task.stage !== "restored") return;
    if (!transparentRequested) {
      task.result = { path: resultPath, healRegions: [] };
      persist("prepared");
      return;
    }
    report("正在处理透明背景…", "working");
    cleanupPath = task.cleanupPath || path.join(os.tmpdir(), "aigc-result-clean-resume-" + Date.now() + ".png");
    task.cleanupPath = cleanupPath;
    return cutoutLayer(resultPath, cleanupPath, { cleanup: false, key: transparentRequested }).catch(function (error) {
      return { path: resultPath, healRegions: [], warning: "本地处理已跳过，保留平台原图：" + safeError(error) };
    }).then(function (result) {
      task.result = result;
      task.cleanupWarning = result.warning || "";
      cleanupWarning = task.cleanupWarning;
      persist("prepared");
    });
  }).then(function () {
    var result = task.result;
    if (!result || !result.path) throw new Error("待恢复任务缺少可回填的结果文件。");
    report("正在放回原选区…", "working");
    persist("placing");
    var fittedPath = "";
    var fittedResult;
    var placeStartedAt = Date.now();
    return fitResultToSelection(result, context.selection).then(function (fitted) {
      fittedResult = fitted;
      if (fitted.path !== result.path) fittedPath = fitted.path;
      return evalHost("placeResult", [fitted.path, context.selection, context.selectionChannelName, context.documentId, fitted.healRegions || [],
        context.source, context.artboard, task.id, context.selectionMaskPath, context.slot]);
    }).then(function (placed) {
      if (!placed || placed.placed !== true) throw new Error("后台助手未确认选区写入，任务和结果已保留。");
      var warnings = (placed && placed.warnings) || [];
      if (cleanupWarning) warnings.unshift(cleanupWarning);
      removePendingTask(task.id);
      report("结果已放回原选区。", "success");
      return cleanupAfterReturn(task.cleanupText, fittedResult, context, task.id, placed, 'cover').then(function (cleanupWarnings) {
        warnings = warnings.concat(cleanupWarnings);
        removeFile(fittedPath);
        removeFile(result.path);
        removeFile(task.resultPath);
        removeFile(task.downloadedPath);
        removeFile(task.croppedPath);
        removeFile(task.cleanupPath);
        removeFile(context.selectionMaskPath);
        var timing = (placed && placed.timing) || {};
        var timingInfo = "";
        if (timing.totalMs > 0) {
          timingInfo = "\n耗时 " + (Date.now() - placeStartedAt) + "ms（PS 内 " + timing.totalMs + "ms";
          timingInfo += "：切换 " + (timing.activateMs || 0) + "，置入 " + Math.max(0, (timing.placeMs || 0) - (timing.healMs || 0));
          timingInfo += "，修复 " + (timing.healMs || 0) + "，切回 " + (timing.restoreMs || 0) + "）";
        }
        report("完成，结果已放回原选区的新图层。" + timingInfo + (warnings.length ? "\n" + warnings.join("\n") : ""), warnings.length ? "" : "success");
        return placed;
      });
    }, function (error) {
      removeFile(fittedPath);
      throw error;
    });
  });
}

function cleanupAfterReturn(enabled, result, context, taskId, receipt, mode) {
  return Promise.resolve([]);
  if (!receipt || !receipt.cleanupToken) return Promise.resolve(["图片已贴回；未取得安全清理凭据，已跳过角落处理。"]);
  var outputPath = result.path.replace(/\.png$/i, "") + "-post-clean.png";
  return Promise.resolve().then(function () {
    return cutoutLayer(result.path, outputPath, { cleanup: true, key: false });
  }).then(function (cleaned) {
    if (cleaned.changed === false) return cleaned.warning ? [cleaned.warning] : [];
    return getBackgroundReturn().cleanup(context, cleaned, taskId, receipt, mode).then(function (outcome) {
      var warnings = outcome && outcome.warnings || [];
      if (cleaned.warning) warnings.unshift(cleaned.warning);
      return warnings;
    });
  }).catch(function (error) {
    return ["图片已贴回；角落字符清理失败，保留已贴回内容：" + safeError(error)];
  }).then(function (warnings) {
    removeFile(outputPath);
    return warnings;
  });
}

function fitResultToSelection(result, selection) {
  var width = Math.round(Number(selection && selection.width));
  var height = Math.round(Number(selection && selection.height));
  if (!(width > 0 && height > 0)) return Promise.resolve(result);
  return loadImageElement(result.path).then(function (image) {
    if (image.width === width && image.height === height) return result;
    var scale = Math.max(width / image.width, height / image.height);
    var drawWidth = image.width * scale;
    var drawHeight = image.height * scale;
    var offsetLeft = (width - drawWidth) / 2;
    var offsetTop = (height - drawHeight) / 2;
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var drawing = canvas.getContext("2d");
    drawing.imageSmoothingQuality = "high";
    drawing.drawImage(image, offsetLeft, offsetTop, drawWidth, drawHeight);
    var outputPath = result.path.replace(/\.png$/i, "") + "-fit.png";
    var regions = (result.healRegions || []).map(function (region) {
      return {
        left: Math.max(0, (offsetLeft + region.left * drawWidth) / width),
        top: Math.max(0, (offsetTop + region.top * drawHeight) / height),
        right: Math.min(1, (offsetLeft + region.right * drawWidth) / width),
        bottom: Math.min(1, (offsetTop + region.bottom * drawHeight) / height)
      };
    }).filter(function (region) { return region.right > region.left && region.bottom > region.top; });
    return { path: writeCanvasPng(canvas, outputPath), healRegions: regions };
  }).catch(function () {
    return result;
  });
}

function processLayerPendingTask(task, client, report) {
  reconcileTaskCache(task);
  var job = task.job || {};
  var result = task.result || null;
  var downloadedPath = task.downloadedPath || "";
  var workDirectory = task.workDirectory || path.join(os.tmpdir(), "aigc-layered-resume-" + Date.now());
  task.workDirectory = workDirectory;
  upsertPendingTask(task);

  function persist(stage) {
    task.stage = stage;
    task.updatedAt = Date.now();
    upsertPendingTask(task);
  }

  return Promise.resolve().then(function () {
    if (!result && !fs.existsSync(workDirectory)) fs.mkdirSync(workDirectory);
  }).then(function () {
    if (result && result.path) return;
    if (task.stage !== "waiting") return;
    report("「" + (job.name || "图层") + "」正在平台生成…", "working");
    return waitForTask(client, task.traceId, Date.now(), function (status, attempt, delay) {
      if (status === "network-retry") networkRetryReporter(report)(attempt, delay);
    }).then(function () { persist("downloading"); });
  }).then(function () {
    if (result && result.path) return;
    if (task.stage !== "downloading") return;
    report("正在下载「" + (job.name || "图层") + "」…", "working");
    return client.downloadResult(task.traceId, path.join(workDirectory, "raw-" + task.index + ".png"), networkRetryReporter(report)).then(function (filePath) {
      downloadedPath = filePath;
      task.downloadedPath = filePath;
      persist("downloaded");
    });
  }).then(function () {
    var target;
    var restored;
    if (result && result.path) return;
    if (!downloadedPath) downloadedPath = task.downloadedPath;
    if (task.stage !== "downloaded") return;
    target = task.target || task.exportInfo && task.exportInfo.source;
    restored = task.sourceFrame ? restoreSelectionFrame(downloadedPath, path.join(workDirectory, "crop-" + task.index + ".png"), task.sourceFrame).catch(function () {
      return downloadedPath;
    }) : Promise.resolve(downloadedPath);
    return restored.then(function (inputPath) {
      return cutoutLayer(inputPath, path.join(workDirectory, "layer-" + task.index + ".png"), {
        width: target.width,
        height: target.height,
        key: job.kind !== "background",
        cleanup: false
      }).then(function (prepared) {
        return prepared;
      }, function (error) {
        return { path: inputPath, healRegions: [], unprocessed: true, warning: "本地透明处理失败，保留平台图像继续回贴：" + safeError(error) };
      });
    }).then(function (prepared) {
      result = {
        path: prepared.path,
        name: job.name,
        healRegions: prepared.healRegions || [],
        target: target,
        unprocessed: !!prepared.unprocessed
      };
      task.result = result;
      task.warning = prepared.warning || "";
      persist("prepared");
    });
  }).then(function () {
    var layerOrder;
    if (!task.result || !task.result.path) throw new Error("待恢复分层任务缺少可回填的结果文件。");
    result = task.result;
    layerOrder = task.layerOrder || [result.name];
    report("正在把「" + result.name + "」放回「" + ((task.exportInfo && task.exportInfo.documentName) || "原 PSD") + "」…", "working");
    persist("placing");
    return evalHost("placeLayeredResult", [[{
      path: result.path,
      name: result.name,
      index: task.index,
      healRegions: result.healRegions || [],
      target: result.target || task.target,
      unprocessed: result.unprocessed,
      taskId: task.id,
      slot: task.slot
    }], task.exportInfo.documentId, task.groupName, task.exportInfo.source, layerOrder, task.exportInfo.artboard]).then(function (placed) {
      var placedNames = placed && placed.placed || [];
      if (placedNames.indexOf(result.name) < 0) throw new Error(placed && placed.failures && placed.failures.join("；") || "放入 Photoshop 失败。");
      removePendingTask(task.id);
      return cleanupAfterReturn(task.cleanupText, result, { documentId: task.exportInfo.documentId,
        source: task.exportInfo.source, artboard: task.exportInfo.artboard, target: result.target || task.target, slot: task.slot },
        task.id, placed.receipts && placed.receipts[task.id], 'contain').then(function (warnings) {
        if (warnings.length) task.warning = (task.warning ? task.warning + "；" : "") + warnings.join("；");
        removeFile(result.path);
        removeFile(downloadedPath);
        report("已恢复并放回「" + result.name + "」。" + (task.warning ? "\n" + task.warning : ""), task.warning ? "" : "success");
        return placed;
      });
    });
  });
}

function resumePendingTasks(client, automatic, taskIds, localOnly) {
  var tasks = loadPendingTasks().filter(function (task) {
    return task && task.id && (!taskIds || taskIds.indexOf(task.id) >= 0) && !resumingTasks[task.id] && !task.recoveryBlocked && !task.recoveryExhausted &&
      (!automatic || taskCanAutoResume(task) && (!task.nextRecoveryAt || task.nextRecoveryAt <= Date.now())) && !(layerBusy && task.type === "layer");
  });
  var hasLayerTasks = tasks.some(function (task) { return task && task.type === "layer"; });
  if (!tasks.length || !client || recoveryClosing) {
    scheduleTaskRecovery(localOnly ? gatewayClient : client);
    return Promise.resolve([]);
  }
  if (hasLayerTasks) layerBusy = true;
  updateControls();
  return Promise.all(tasks.map(function (task) {
    if (!task || !task.id || resumingTasks[task.id]) return Promise.resolve();
    resumingTasks[task.id] = true;
    task.autoResume = true;
    task.lastRecoveryError = null;
    task.recoveryMessage = "正在重新取回…";
    upsertPendingTask(task);
    if (task.type === "selection") selectionJobs += 1;
    updateControls();
    var report = function (message, kind) {
      if (loadPendingTasks().some(function (pending) { return pending.id === task.id; })) {
        task.recoveryMessage = task.lastRecoveryError ? "" : message;
        upsertPendingTask(task);
      }
      if (task.type === "layer") setLayerStatus(message, kind);
      else setStatus("恢复任务：" + message, kind);
    };
    var promise = Promise.resolve().then(function () {
      return task.type === "layer" ? processLayerPendingTask(task, client, report) : processSelectionPendingTask(task, client, report);
    }).then(function (placed) {
      if (task.type === "layer" && lastLayerRun && lastLayerRun.taskIds && lastLayerRun.taskIds[task.index] === task.id) {
        lastLayerRun.results[task.index] = task.result;
        lastLayerRun.placed[task.index] = true;
        delete lastLayerRun.failures[task.index];
        lastLayerRun.pendingCount = lastLayerRun.jobs.filter(function (job, index) { return !lastLayerRun.placed[index]; }).length;
        if (!lastLayerRun.pendingCount) {
          removeDirectory(lastLayerRun.workDirectory);
          removeFile(lastLayerRun.exportInfo.imagePath);
        }
      }
      return placed;
    });
    return promise.catch(function (error) {
      if (error && error.platformFailed) {
        removePendingTask(task.id);
        if (task.type === "selection" && task.context) {
          removeFile(task.context.selectionMaskPath);
          return evalHost("discardSelection", [task.context.selectionChannelName, task.context.documentId]).catch(function () {}).then(function () {
            report(safeError(error), "error");
          });
        }
        report(safeError(error), "error");
        return;
      }
      markTaskForRecovery(task, error);
      report(taskFailureMessage(error, task), task.autoResume ? "working" : "error");
    }).then(function () {
      delete resumingTasks[task.id];
      if (task.type === "selection") selectionJobs -= 1;
      updateControls();
    });
  })).then(function (results) {
    if (hasLayerTasks) layerBusy = false;
    updateControls();
    scheduleTaskRecovery(localOnly ? gatewayClient : client);
    return results;
  });
}

function runGeneration() {
  var prompt = getElement("prompt").value.replace(/^\s+|\s+$/g, "");
  var modelKey = getSelectedModelKey();
  var client = gatewayClient;
  var parameters = readParameterValues();
  var model = getSelectedModel();
  var cleanupText = false;
  var cleanupPath = null;
  var croppedPath = null;
  var downloadedResultPath = null;
  var cleanupWarning = "";
  var retainedPath = null;
  var jobNumber;
  var resultPath;
  var context = null;
  var pendingTask = null;
  var references = referenceImages.slice();
  var capacity = null;

  if (!connected || !client) {
    setStatus("请先连接平台。", "error");
    return;
  }
  if (!modelKey) {
    setStatus("请选择平台提供的生图模型。", "error");
    return;
  }
  if (!prompt) {
    setStatus("请输入提示词。", "error");
    return;
  }
  if (referenceLoading) {
    setStatus("参考图仍在读取，请稍后提交。", "error");
    return;
  }

  try { capacity = reservePendingCapacity(1); }
  catch (error) { setStatus(safeError(error), "error"); return; }

  selectionCounter += 1;
  jobNumber = selectionCounter;
  resultPath = path.join(os.tmpdir(), "aigc-result-" + Date.now() + "-" + jobNumber + ".png");
  try { saveSettings(); }
  catch (error) { releasePendingCapacity(capacity); setStatus(safeError(error), "error"); return; }
  selectionJobs += 1;
  updateControls();

  function report(message, kind) {
    setStatus("选区 #" + jobNumber + "：" + message, kind);
  }

  report("正在后台读取选区…", "working");
  return exportCapturedSelection('AIGC 选区 #' + jobNumber + ' 返回结果', require('crypto').randomBytes(16).toString('hex')).then(function (exported) {
    context = exported;
    return prepareExportedImage(exported);
  }).then(function () {
    return prepareSelectionUpload(context, model, parameters);
  }).then(function (uploadPath) {
    report("正在上传图1（PS 选区）…", "working");
    return client.uploadSelection(uploadPath);
  }).then(function (imageUrl) {
    removeFile(context.imagePath);
    removeFile(context.uploadPath);
    return uploadReferenceImages(client, references, report).then(function (referenceUrls) {
      references.length = 0;
      report("正在提交任务（" + (referenceUrls.length + 1) + "张图）…", "working");
      var taskPrompt = referenceUrls.length ? "图1是要编辑的 Photoshop 选区，图2至图" + (referenceUrls.length + 1) + "是额外参考图。按用户要求编辑图1，只输出编辑结果，不要拼接参考图。\n用户要求：\n" + prompt : prompt;
      if (context.generationFrame) taskPrompt += "\n保持图1整个画布的比例与构图。四周灰色补边只用于比例适配，请保留补边和原内容的边界位置，不要裁切、缩放或重新居中主体；只在原图内容区域内编辑。";
      return Promise.resolve().then(function () {
        return client.createImage({ modelKey: modelKey, prompt: taskPrompt, imageUrl: imageUrl, referenceUrls: referenceUrls, parameters: context.generationParameters });
      }).catch(function (error) {
        if (referenceUrls.length) throw new Error("多图提交失败（共" + (referenceUrls.length + 1) + "张），未自动改为单图。请确认模型支持该参考图数量。\n" + safeError(error));
        throw error;
      });
    });
  }).then(function (traceId) {
    pendingTask = {
      id: selectionTaskId(traceId), type: "selection", traceId: traceId, stage: "waiting", autoResume: true, createdAt: Date.now(),
      jobNumber: jobNumber, cleanupText: cleanupText, resultPath: resultPath, context: context
    };
    upsertPendingTask(pendingTask);
    releasePendingCapacity(capacity);
    resumingTasks[pendingTask.id] = true;
    return processSelectionPendingTask(pendingTask, client, report);
  }).catch(function (error) {
    retainedPath = pendingTask && pendingTask.result && pendingTask.result.path || pendingTask && pendingTask.downloadedPath || "";
    if (pendingTask && error && error.platformFailed) removePendingTask(pendingTask.id);
    if (!pendingTask || error && error.platformFailed) {
      if (resultPath !== retainedPath) removeFile(resultPath);
      if (cleanupPath !== retainedPath) removeFile(cleanupPath);
      if (downloadedResultPath !== retainedPath) removeFile(downloadedResultPath);
      if (croppedPath !== retainedPath) removeFile(croppedPath);
      if (context) removeFile(context.imagePath);
      if (context) removeFile(context.selectionMaskPath);
    }
    if (pendingTask && !error.platformFailed) markTaskForRecovery(pendingTask, error);
    report(taskFailureMessage(error, pendingTask) + (retainedPath ? "\n结果已保留：" + retainedPath : ""), pendingTask && pendingTask.autoResume ? "working" : "error");
  }).then(function () {
    references.length = 0;
    if (context) removeFile(context.uploadPath);
    if (context && context.selectionChannelName && (!pendingTask || pendingTask.stage !== "placing" && !loadPendingTasks().some(function (task) { return task.id === pendingTask.id; }))) {
      return evalHost("discardSelection", [context.selectionChannelName, context.documentId]).catch(function () {});
    }
  }).then(function () {
    if (pendingTask) delete resumingTasks[pendingTask.id];
    releasePendingCapacity(capacity);
    selectionJobs -= 1;
    updateControls();
    scheduleTaskRecovery(client);
  });
}
function findModelOption(model, name, value) {
  var found = false;
  if (!model || !model.parameters) return false;
  model.parameters.forEach(function (parameter) {
    if (parameter.name !== name || !parameter.options) return;
    parameter.options.forEach(function (item) {
      var optionValue = item && typeof item === "object" ? (item.value !== undefined ? item.value : item.id) : item;
      if (String(optionValue).toLowerCase() === value) found = true;
    });
  });
  return found;
}

function findModelParameter(model, name) {
  var index;
  if (!model || !model.parameters) return null;
  for (index = 0; index < model.parameters.length; index += 1) {
    if (model.parameters[index].name === name) return model.parameters[index];
  }
  return null;
}

function loadImageElement(filePath) {
  return new Promise(function (resolve, reject) {
    var image = new Image();
    var extension = path.extname(filePath).toLowerCase();
    var mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : (extension === ".webp" ? "image/webp" : "image/png");
    image.onload = function () { resolve(image); };
    image.onerror = function () { reject(new Error("无法读取平台返回的图片。")); };
    image.src = "data:" + mime + ";base64," + fs.readFileSync(filePath).toString("base64");
  });
}

function canvasFromImage(image, width, height) {
  var canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  var context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

function maskAlphaAt(maskCanvas, width, height) {
  var canvas = canvasFromImage(maskCanvas, width, height);
  var data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  var mask = new Uint8Array(width * height);
  var index;
  for (index = 0; index < mask.length; index += 1) mask[index] = data[index * 4 + 3];
  return mask;
}

function writeCanvasPng(canvas, outputPath) {
  var base64 = canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
  return outputPath;
}

function cutoutLayer(inputPath, outputPath, options) {
  return loadImageElement(inputPath).then(function (image) {
    var canvas = canvasFromImage(image, image.width, image.height);
    var context = canvas.getContext("2d");
    var pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    var warnings = [];
    var regions = [];
    var cleanup = { deleted: 0, healRegions: [] };
    if (options.cleanup) {
      try {
        regions = AIGCResultCleanup.detectCornerText(pixels.data, canvas.width, canvas.height);
        if (!regions.length) warnings.push("未识别到可安全清理的角落字符，已保留原图内容");
      } catch (detectError) {
        warnings.push("角落字符识别已跳过：" + safeError(detectError));
      }
    }
    if (options.key) {
      var backup = new Uint8ClampedArray(pixels.data);
      var keyed = AIGCLayerPlan.chromaKey(pixels.data, canvas.width, canvas.height, {});
      if (keyed.keyed && AIGCLayerPlan.opaqueRatio(pixels.data) < 0.003) {
        pixels.data.set(backup);
        warnings.push("自动抠图后几乎为空，已保留原图");
      } else if (!keyed.keyed && keyed.reason !== "transparent") {
        warnings.push("平台返回的 PNG 没有真实透明通道，也没有可安全抠除的纯绿背景；棋盘格可能是图片像素，已保留原图以免误删主体");
      }
    }
    if (regions.length) {
      try {
        cleanup = AIGCResultCleanup.prepareCleanup(pixels.data, canvas.width, canvas.height, regions, { repair: true });
        if (cleanup.skipped) warnings.push("部分角落字符与图像细节无法区分，已保留以免误删");
        if (cleanup.repairIncomplete) warnings.push("部分字符缺少可采样像素，已保留残余以免误删图像内容");
      } catch (cleanupError) {
        warnings.push("角落字符清理已跳过：" + safeError(cleanupError));
      }
    }
    if (options.key && AIGCLayerPlan.opaqueRatio(pixels.data) < 0.0005) warnings.push("结果几乎为空");
    context.putImageData(pixels, 0, 0);
    if (options.width && options.height && (canvas.width !== options.width || canvas.height !== options.height)) {
      var fit = AIGCLayerPlan.containGeometry(canvas.width, canvas.height, options.width, options.height);
      var fitted = document.createElement("canvas");
      fitted.width = options.width;
      fitted.height = options.height;
      var fittedContext = fitted.getContext("2d");
      fittedContext.imageSmoothingQuality = "high";
      fittedContext.drawImage(canvas, fit.left, fit.top, fit.width, fit.height);
      cleanup.healRegions = AIGCLayerPlan.mapHealRegions(cleanup.healRegions, fit, fitted.width, fitted.height);
      if (Math.abs(Math.log((canvas.width / canvas.height) / (options.width / options.height))) > 0.025) {
        warnings.push("平台返回比例与参考图不同，已等比适配并留透明边，未拉伸主体");
      }
      canvas = fitted;
    }
    return { path: writeCanvasPng(canvas, outputPath), warning: warnings.join("；"), healRegions: cleanup.healRegions,
      changed: !!(cleanup.deleted || cleanup.repaired) };
  });
}

function guideLayerNames() {
  var names = AIGCLayerPlan.parseLayerList(getElement("layerList").value);
  return names.length > 1 ? names.slice(0, -1) : names;
}

function guideColor(name) {
  var index = AIGCLayerPlan.parseLayerList(getElement("layerList").value).indexOf(name);
  return GUIDE_COLORS[(index < 0 ? 0 : index) % GUIDE_COLORS.length];
}

function guideMask(name, create) {
  if (!guide.masks[name] && create) {
    var canvas = document.createElement("canvas");
    canvas.width = guide.width;
    canvas.height = guide.height;
    guide.masks[name] = canvas;
  }
  return guide.masks[name] || null;
}

function refreshGuideLayers() {
  var select = getElement("guideLayer");
  var current = select.value;
  select.innerHTML = "";
  guideLayerNames().forEach(function (name) {
    var option = document.createElement("option");
    option.value = name;
    option.textContent = "● " + name;
    option.style.color = guideColor(name);
    if (name === current) option.selected = true;
    select.appendChild(option);
  });
  getElement("guideSwatch").style.background = select.value ? guideColor(select.value) : "transparent";
  redrawGuide();
}

function redrawGuide() {
  var canvas = getElement("guideCanvas");
  if (!guide.image) return;
  var context = canvas.getContext("2d");
  var tint = document.createElement("canvas");
  tint.width = guide.width;
  tint.height = guide.height;
  var tintContext = tint.getContext("2d");
  context.globalAlpha = 1;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(guide.image, 0, 0, canvas.width, canvas.height);
  guideLayerNames().forEach(function (name) {
    var mask = guideMask(name, false);
    if (!mask) return;
    tintContext.globalCompositeOperation = "source-over";
    tintContext.clearRect(0, 0, tint.width, tint.height);
    tintContext.drawImage(mask, 0, 0);
    tintContext.globalCompositeOperation = "source-in";
    tintContext.fillStyle = guideColor(name);
    tintContext.fillRect(0, 0, tint.width, tint.height);
    context.globalAlpha = 0.5;
    context.drawImage(tint, 0, 0);
  });
  context.globalAlpha = 1;
}

function loadGuidePreview() {
  getElement("guideButton").disabled = true;
  setLayerStatus("正在读取画面…", "working");
  evalHost("exportDocument", []).then(prepareExportedImage).then(function (exported) {
    return loadImageElement(exported.imagePath).then(function (image) {
      removeFile(exported.imagePath);
      var scale = Math.min(1, GUIDE_MAX_SIZE / Math.max(image.width, image.height));
      var width = Math.max(1, Math.round(image.width * scale));
      var height = Math.max(1, Math.round(image.height * scale));
      if (guide.docId !== exported.documentId || guide.width !== width || guide.height !== height) guide.masks = {};
      guide.docId = exported.documentId;
      guide.docName = exported.documentName;
      guide.source = exported.source;
      guide.image = image;
      guide.width = width;
      guide.height = height;
      getElement("guideCanvas").width = width;
      getElement("guideCanvas").height = height;
      getElement("guideEditor").hidden = false;
      getElement("guideButton").textContent = "刷新预览";
      refreshGuideLayers();
      setLayerStatus("蒙版属于「" + guide.docName + "」；涂抹区域优先，不涂的层由 AI 自行识别。", "");
    }, function (error) {
      removeFile(exported.imagePath);
      throw error;
    });
  }).catch(function (error) {
    setLayerStatus(safeError(error), "error");
  }).then(function () {
    updateControls();
  });
}

function guidePoint(event) {
  var canvas = getElement("guideCanvas");
  var rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height,
    scale: canvas.width / rect.width
  };
}

function paintGuide(point) {
  var name = getElement("guideLayer").value;
  if (!name || !guide.image) return;
  var mask = guideMask(name, true);
  var context = mask.getContext("2d");
  var from = guide.last || point;
  context.globalCompositeOperation = guide.tool === "erase" ? "destination-out" : "source-over";
  context.strokeStyle = "#ffffff";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Number(getElement("guideBrush").value) * point.scale;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(point.x + 0.01, point.y);
  context.stroke();
  guide.last = point;
  redrawGuide();
}

function setGuideTool(tool) {
  guide.tool = tool;
  getElement("guideBrushTool").className = "tool" + (tool === "brush" ? " active" : "");
  getElement("guideEraseTool").className = "tool" + (tool === "erase" ? " active" : "");
}

function snapshotGuideMasks(documentId) {
  var masks = {};
  var used = 0;
  if (!guide.image || String(guide.docId) !== String(documentId)) return { masks: masks, used: 0 };
  guideLayerNames().forEach(function (name) {
    var mask = guideMask(name, false);
    if (!mask) return;
    var alpha = maskAlphaAt(mask, guide.width, guide.height);
    if (!AIGCLayerPlan.hasMaskPixels(alpha)) return;
    var canvas = document.createElement("canvas");
    canvas.width = guide.width;
    canvas.height = guide.height;
    var context = canvas.getContext("2d");
    var image = context.createImageData(guide.width, guide.height);
    var index;
    for (index = 0; index < alpha.length; index += 1) {
      image.data[index * 4] = 255;
      image.data[index * 4 + 1] = 255;
      image.data[index * 4 + 2] = 255;
      image.data[index * 4 + 3] = alpha[index];
    }
    context.putImageData(image, 0, 0);
    masks[name] = canvas;
    used += 1;
  });
  return { masks: masks, used: used };
}
function populateLayerTemplates(selectedId, savedList) {
  var select = getElement("layerTemplate");
  select.innerHTML = "";
  AIGCLayerPlan.TEMPLATES.forEach(function (template) {
    var option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    if (template.id === selectedId) option.selected = true;
    select.appendChild(option);
  });
  getElement("layerList").value = savedList || AIGCLayerPlan.findTemplate(select.value).layers.join("\n");
}

function layerParameters(run, kind, target) {
  var parameters = JSON.parse(JSON.stringify(run.parameters));
  if (parameters.AspectRatio === AIGCSelectionFrame.ORIGINAL) delete parameters.AspectRatio;
  var ratioParameter = findModelParameter(run.model, "AspectRatio");
  if (!target && run.sourceRatio) {
    parameters.AspectRatio = run.sourceRatio;
  } else if (ratioParameter) {
    var frame = target || run.exportInfo.source;
    var ratio = AIGCLayerPlan.closestAspectRatio(ratioParameter.options, frame.width, frame.height);
    if (ratio) parameters.AspectRatio = ratio;
  }
  if (findModelParameter(run.model, "Background")) {
    if (kind === "element" && run.transparentSupported) parameters.Background = "transparent";
    else if (kind === "background" && findModelOption(run.model, "Background", "opaque")) parameters.Background = "opaque";
  }
  return parameters;
}

function reportLayerProgress(run) {
  var total = run.jobs.length;
  var done = 0;
  var submitted = 0;
  var placedCount = 0;
  var lines = [];
  run.jobs.forEach(function (job, index) {
    if (run.results[index]) done += 1;
    if (run.traces[index]) submitted += 1;
    if (run.placed && run.placed[index]) placedCount += 1;
    if (run.failures[index]) lines.push(run.failures[index]);
  });
  setLayerStatus("分层：已提交 " + submitted + "/" + total + "，已完成 " + done + "/" + total + "，已贴回 " + placedCount + "/" + total +
    (lines.length ? "\n失败：\n" + lines.join("\n") : ""), "working");
}

function layerReference(run, index) {
  var job = run.jobs[index];
  var mask = run.masks[job.name];
  if (job.kind === "background" || !mask) return Promise.resolve(run.imageUrl);
  if (run.guidedUrls[index]) return Promise.resolve(run.guidedUrls[index]);
  return loadImageElement(run.exportInfo.imagePath).then(function (image) {
    var source = run.exportInfo.source;
    var ratioParameter = findModelParameter(run.model, "AspectRatio");
    var target = AIGCLayerPlan.guideGeometry(maskAlphaAt(mask, mask.width, mask.height), mask.width, mask.height,
      source.width, source.height, ratioParameter ? ratioParameter.options : []);
    if (!target) throw new Error("涂抹范围为空，请刷新预览后重试。");
    run.targets[index] = target;
    var canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    var context = canvas.getContext("2d");
    context.fillStyle = "#808080";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, -target.left, -target.top, source.width, source.height);
    var croppedMask = document.createElement("canvas");
    croppedMask.width = target.width;
    croppedMask.height = target.height;
    croppedMask.getContext("2d").drawImage(mask, -target.left, -target.top, source.width, source.height);
    var pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    AIGCLayerPlan.annotateGuide(pixels.data, maskAlphaAt(croppedMask, canvas.width, canvas.height));
    context.putImageData(pixels, 0, 0);
    return run.client.uploadSelection(writeCanvasPng(canvas, path.join(run.workDirectory, "guided-" + index + ".png")));
  }).then(function (imageUrl) {
    run.guidedUrls[index] = imageUrl;
    return imageUrl;
  });
}

function processLayerJob(run, index) {
  var job = run.jobs[index];
  var stage = "submit";
  run.taskIds = run.taskIds || [];
  run.taskCreatedAt = run.taskCreatedAt || [];
  run.downloadedPaths = run.downloadedPaths || [];
  if (run.results[index]) return Promise.resolve();
  delete run.failures[index];
  return Promise.resolve().then(function () {
    if (run.traces[index]) return run.traces[index];
    return layerReference(run, index).then(function (imageUrl) {
      var prompt = job.kind !== "background" && run.masks[job.name] ?
        AIGCLayerPlan.guidedPrompt(job.name, !!run.transparentSupported, run.userPrompt) : job.prompt;
      if (!run.targets[index] && run.sourceFrame) prompt += "\n保持图1整个画布比例与构图，四周灰色补边只用于比例适配，不要把画面内容移入或延伸到补边，不要缩放或重新居中。";
      return run.client.createImage({
        modelKey: run.modelKey,
        prompt: prompt,
        imageUrl: imageUrl,
        parameters: layerParameters(run, job.kind, run.targets[index])
      });
    }).then(function (traceId) {
      run.traces[index] = traceId;
      layerTaskFromRun(run, index, "waiting");
      releasePendingCapacity(run.capacity, 1);
      reportLayerProgress(run);
      return traceId;
    });
  }).then(function (traceId) {
    stage = "wait";
    return waitForTask(run.client, traceId, Date.now(), function (status, attempt, delay) {
      if (status === "network-retry") networkRetryReporter(setLayerStatus)(attempt, delay);
    });
  }).then(function () {
    stage = "download";
    layerTaskFromRun(run, index, "downloading");
    return run.client.downloadResult(run.traces[index], path.join(run.workDirectory, "raw-" + index + ".png"), networkRetryReporter(setLayerStatus));
  }).then(function (downloadedPath) {
    stage = "cutout";
    run.downloadedPaths[index] = downloadedPath;
    layerTaskFromRun(run, index, "downloaded", { downloadedPath: downloadedPath });
    var target = run.targets && run.targets[index] || run.exportInfo.source;
    var framed = !(run.targets && run.targets[index]) && run.sourceFrame;
    var restored = framed ? restoreSelectionFrame(downloadedPath, path.join(run.workDirectory, "crop-" + index + ".png"), run.sourceFrame).catch(function (error) {
      run.warnings.push(job.name + "：" + safeError(error));
      return downloadedPath;
    }) : Promise.resolve(downloadedPath);
    return restored.then(function (inputPath) {
      return cutoutLayer(inputPath, path.join(run.workDirectory, "layer-" + index + ".png"), {
        width: target.width,
        height: target.height,
        key: job.kind !== "background",
        cleanup: false
      }).then(function (result) {
        return result;
      }, function (error) {
        return { path: inputPath, healRegions: [], unprocessed: true, warning: "本地透明处理失败，保留平台图像继续回贴：" + safeError(error) };
      });
    });
  }).then(function (result) {
    run.results[index] = { path: result.path, name: job.name, healRegions: result.healRegions,
      target: run.targets && run.targets[index] || run.exportInfo.source, unprocessed: !!result.unprocessed };
    layerTaskFromRun(run, index, "prepared", { result: run.results[index] });
    if (result.warning) run.warnings.push(job.name + "：" + result.warning);
  }).catch(function (error) {
    if (stage === "wait" && error && error.platformFailed) {
      removePendingTask(run.taskIds[index]);
      run.traces[index] = null;
    }
    if (run.traces[index] && AIGCGateway.isRetryableError(error)) {
      var savedTask = loadPendingTasks().filter(function (task) { return task.id === run.taskIds[index]; })[0];
      if (savedTask) markTaskForRecovery(savedTask, error);
    }
    run.failures[index] = job.name + "：" + safeError(error) +
      (run.traces[index] ? "（任务 " + String(run.traces[index]).slice(0, 8) + "）" : "");
  }).then(function () {
    reportLayerProgress(run);
  });
}

function placeLayerRun(run) {
  var batch = [];
  var lowerPlaced = null;
  run.taskIds = run.taskIds || [];
  run.placeAttempted = run.placeAttempted || {};
  run.jobs.forEach(function (job, index) {
    var result = run.results[index];
    if (result && !run.placed[index] && !run.placeAttempted[index]) {
      run.placeAttempted[index] = true;
      batch.push({ path: result.path, name: result.name, belowName: lowerPlaced, index: index, healRegions: result.healRegions,
        target: result.target, unprocessed: result.unprocessed, taskId: run.taskIds[index], slot: run.slots && run.slots[index] });
    }
    if (result) lowerPlaced = job.name;
  });
  if (!batch.length) return Promise.resolve([]);
  batch.forEach(function (item) {
    var savedTask = loadPendingTasks().filter(function (task) { return task.id === item.taskId; })[0];
    if (!savedTask) return;
    savedTask.stage = "placing";
    savedTask.autoResume = true;
    savedTask.updatedAt = Date.now();
    upsertPendingTask(savedTask);
  });
  setLayerStatus("正在把「" + batch.map(function (item) { return item.name; }).join("、") + "」放回「" + (run.exportInfo.documentName || "原 PSD") + "」…", "working");
  var layerOrder = run.jobs.map(function (job) { return job.name; });
  var failures = [];
  var chain = Promise.resolve();
  batch.forEach(function (item) {
    chain = chain.then(function () {
      return evalHost("placeLayeredResult", [[item], run.exportInfo.documentId, run.groupName, run.exportInfo.source, layerOrder, run.exportInfo.artboard]).then(function (placed) {
        if (placed && placed.warnings) run.warnings = run.warnings.concat(placed.warnings);
        var placedNames = (placed && placed.placed) || [];
        if (placedNames.indexOf(item.name) >= 0) {
          run.placed[item.index] = true;
          removePendingTask(run.taskIds[item.index]);
          return cleanupAfterReturn(run.cleanupText, item, { documentId: run.exportInfo.documentId,
            source: run.exportInfo.source, artboard: run.exportInfo.artboard, target: item.target || run.exportInfo.source, slot: item.slot },
            item.taskId, placed.receipts && placed.receipts[item.taskId], 'contain').then(function (warnings) {
            run.warnings = run.warnings.concat(warnings);
            removeFile(item.path);
            removeFile(run.downloadedPaths && run.downloadedPaths[item.index]);
          });
        } else {
          run.failures[item.index] = item.name + "：放入 Photoshop 失败";
          var savedTask = loadPendingTasks().filter(function (task) { return task.id === item.taskId; })[0];
          if (savedTask) markTaskForRecovery(savedTask, new Error(((placed && placed.failures) || []).join("\n") || run.failures[item.index]));
        }
        failures = failures.concat((placed && placed.failures) || []);
      }, function (error) {
        run.failures[item.index] = item.name + "：" + safeError(error);
        var savedTask = loadPendingTasks().filter(function (task) { return task.id === item.taskId; })[0];
        if (savedTask) markTaskForRecovery(savedTask, error);
      });
    });
  });
  return chain.then(function () { return failures; });
}

function queueLayerPlacement(run) {
  run.placeChain = run.placeChain.then(function () {
    return placeLayerRun(run);
  }).then(function (hostFailures) {
    run.hostFailures = run.hostFailures.concat(hostFailures || []);
    reportLayerProgress(run);
  }, function (error) {
    run.warnings.push(safeError(error));
  });
  return run.placeChain;
}

function executeLayerRun(run) {
  var pending = [];
  run.jobs.forEach(function (job, index) {
    if (!run.placed[index]) pending.push(index);
  });
  layerBusy = true;
  lastLayerRun = run;
  run.hostFailures = [];
  run.placeAttempted = {};
  run.placeChain = Promise.resolve();
  updateControls();
  reportLayerProgress(run);
  return AIGCLayerPlan.runPool(pending, LAYER_CONCURRENCY, function (index) {
    return processLayerJob(run, index).then(function () {
      if (run.results[index] && !run.placed[index]) queueLayerPlacement(run);
    });
  }).then(function () {
    return run.placeChain;
  }).then(function () {
    return queueLayerPlacement(run);
  }).then(function (hostFailures) {
    var placedCount = 0;
    var failures = [];
    run.jobs.forEach(function (job, index) {
      if (run.placed[index]) placedCount += 1;
      else if (run.failures[index]) failures.push(run.failures[index]);
      else failures.push(job.name + "：未完成");
    });
    failures = failures.concat(run.hostFailures);
    run.pendingCount = run.jobs.length - placedCount;
    var notes = run.warnings.length ? "\n提示：" + run.warnings.join("；") : "";
    if (!run.pendingCount) {
      removeDirectory(run.workDirectory);
      removeFile(run.exportInfo.imagePath);
      setLayerStatus("完成：「" + run.groupName + "」共 " + placedCount + " 层。" + notes, run.warnings.length ? "" : "success");
    } else {
      setLayerStatus("完成 " + placedCount + "/" + run.jobs.length + " 层，可点「重新取回失败图层」。\n" + failures.join("\n") + notes, "error");
    }
  }).catch(function (error) {
    run.pendingCount = run.jobs.length;
    setLayerStatus(safeError(error), "error");
  }).then(function () {
    layerBusy = false;
    releasePendingCapacity(run.capacity);
    updateControls();
    scheduleTaskRecovery(run.client);
  });
}

function runLayeredPsd() {
  var userPrompt = getElement("prompt").value.replace(/^\s+|\s+$/g, "");
  var model = getSelectedModel();
  var now = new Date();
  var run = {
    client: gatewayClient,
    modelKey: getSelectedModelKey(),
    model: model,
    parameters: readParameterValues(),
    userPrompt: userPrompt,
    cleanupText: false,
    transparentSupported: findModelOption(model, "Background", "transparent"),
    workDirectory: path.join(os.tmpdir(), "aigc-layered-" + Date.now()),
    groupName: "AI 分层 " + ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2) + ":" + ("0" + now.getSeconds()).slice(-2) + " · " + now.getTime(),
    jobs: null,
    exportInfo: null,
    imageUrl: "",
    masks: {},
    targets: [],
    guidedUrls: [],
    traces: [],
    taskIds: [],
    taskCreatedAt: [],
    downloadedPaths: [],
    results: [],
    placed: [],
    failures: {},
    warnings: [],
    pendingCount: 0
  };

  if (!connected || !run.client) {
    setLayerStatus("请先连接平台。", "error");
    return;
  }
  if (!run.modelKey) {
    setLayerStatus("请选择平台提供的生图模型。", "error");
    return;
  }
  try {
    run.jobs = AIGCLayerPlan.buildLayerJobs(AIGCLayerPlan.parseLayerList(getElement("layerList").value), userPrompt, run.transparentSupported);
    run.capacity = reservePendingCapacity(run.jobs.length);
  } catch (error) {
    setLayerStatus(safeError(error), "error");
    return;
  }

  var snapshot;
  try {
    if (lastLayerRun) {
      var protectedPaths = pendingTaskPathMap();
      if (!isPendingTaskPath(lastLayerRun.workDirectory, protectedPaths)) removeDirectory(lastLayerRun.workDirectory);
      if (lastLayerRun.exportInfo && !isPendingTaskPath(lastLayerRun.exportInfo.imagePath, protectedPaths)) removeFile(lastLayerRun.exportInfo.imagePath);
    }
    lastLayerRun = null;
    saveSettings();
    fs.mkdirSync(run.workDirectory);
    snapshot = snapshotGuideMasks(guide.docId);
  } catch (error) {
    releasePendingCapacity(run.capacity);
    setLayerStatus(safeError(error), "error");
    return;
  }
  layerBusy = true;
  updateControls();
  setLayerStatus("正在后台读取原图…", "working");
  var guideSource = snapshot.used ? guide.source : null;
  var guideDocumentId = snapshot.used ? guide.docId : null;
  run.masks = snapshot.masks;
  exportPixelSubmission({ documentId: guideDocumentId, selection: false, reservation: {
    names: run.jobs.map(function (job) { return job.name; }), groupName: run.groupName,
    id: require('crypto').randomBytes(16).toString('hex') } }).then(function (exported) {
    run.exportInfo = exported;
    if (guideSource && (guideSource.width !== exported.source.width || guideSource.height !== exported.source.height)) {
      throw new Error("原 PSD 尺寸已变化，请刷新蒙版预览后重新涂抹。");
    }
    setLayerStatus("正在上传「" + exported.documentName + "」…" + (snapshot.used ? "（使用 " + snapshot.used + " 个涂抹区域）" : ""), "working");
    run.slots = exported.slots;
    return prepareLayerSource(run).then(function (uploadPath) {
      return run.client.uploadSelection(uploadPath);
    });
  }).then(function (imageUrl) {
    run.imageUrl = imageUrl;
    return executeLayerRun(run);
  }).catch(function (error) {
    releasePendingCapacity(run.capacity);
    removeDirectory(run.workDirectory);
    if (run.exportInfo) removeFile(run.exportInfo.imagePath);
    layerBusy = false;
    updateControls();
    setLayerStatus(safeError(error), "error");
  });
}

function prepareLayerSource(run) {
  var source = run.exportInfo.source;
  var resolved;
  try {
    resolved = AIGCSelectionFrame.resolve({ AspectRatio: AIGCSelectionFrame.ORIGINAL }, findModelParameter(run.model, "AspectRatio"), source.width, source.height, watermarkMargin());
  } catch (error) {
    return Promise.resolve(run.exportInfo.imagePath);
  }
  run.sourceRatio = resolved.parameters.AspectRatio || "";
  run.sourceFrame = resolved.frame;
  if (!resolved.frame) return Promise.resolve(run.exportInfo.imagePath);
  return writeFramedImage(run.exportInfo.imagePath, path.join(run.workDirectory, "source-frame.png"), resolved.frame);
}

function retryLayers() {
  if (!lastLayerRun || layerBusy || !connected) return;
  var unsubmitted = lastLayerRun.jobs.filter(function (job, index) { return !lastLayerRun.placed[index] && !lastLayerRun.traces[index]; }).length;
  try { lastLayerRun.capacity = unsubmitted ? reservePendingCapacity(unsubmitted) : null; }
  catch (error) { setLayerStatus(safeError(error), "error"); return; }
  executeLayerRun(lastLayerRun);
}

window.addEventListener("load", function () {
  keepPanelAlive();
  var settings = loadSettings();
  preparePendingRecovery();
  enableTextInputIme();
  try { getBackgroundBridge().start().catch(function (error) { setStatus(safeError(error), "error"); }); }
  catch (error) { setStatus("后台助手未安装，请运行完整实验包中的安装.bat。", "error"); }
  cleanupStaleTempFiles();
  populateLayerTemplates(settings.layerTemplate, settings.layerList);
  getElement("prompt").value = settings.prompt || "";
  getElement("watermarkMargin").checked = settings.watermarkMargin !== false;
  getElement("watermarkMargin").addEventListener("change", function () { saveSettings(); });
  getElement("watermarkAxis").value = settings.watermarkAxis === "horizontal" ? "horizontal" : "vertical";
  getElement("watermarkAxis").addEventListener("change", function () { saveSettings(); });
  setConnected(false);
  getElement("connectButton").addEventListener("click", connectPlatform);
  getElement("connectionSettingsButton").addEventListener("click", function () { setConnectionPanelOpen(true); });
  getElement("closeConnectionButton").addEventListener("click", function () { setConnectionPanelOpen(false); });
  getElement("connectionOverlay").addEventListener("click", function (event) {
    if (event.target === this) setConnectionPanelOpen(false);
  });
  getElement("taskProgressButton").addEventListener("click", function () { setTaskPanelOpen(true); });
  getElement("closeTaskProgressButton").addEventListener("click", function () { setTaskPanelOpen(false); });
  getElement("taskProgressOverlay").addEventListener("click", function (event) { if (event.target === this) setTaskPanelOpen(false); });
  getElement("taskSortButton").addEventListener("click", function () {
    taskOldestFirst = !taskOldestFirst;
    this.textContent = taskOldestFirst ? "旧任务在前 ↓" : "新任务在前 ↓";
    renderTaskProgress();
  });
  getElement("clearPausedTasksButton").addEventListener("click", function () { dismissPendingTasks(); });
  document.addEventListener("keydown", function (event) {
    if (isImeComposing(event) || isTextEditingTarget(event.target)) return;
    if (event.key === "Escape" && !getElement("connectionOverlay").hidden) setConnectionPanelOpen(false);
    if (event.key === "Escape" && !getElement("taskProgressOverlay").hidden) setTaskPanelOpen(false);
  });
  getElement("submitButton").addEventListener("click", runGeneration);
  renderReferenceImages();
  bindReferencePaste();
  getElement("addReferenceButton").addEventListener("click", function () { getElement("referenceFileInput").click(); });
  getElement("referenceFileInput").addEventListener("change", function () {
    var files = Array.prototype.slice.call(this.files || []);
    this.value = "";
    addReferenceFiles(files);
  });
  getElement("layeredButton").addEventListener("click", runLayeredPsd);
  getElement("retryLayersButton").addEventListener("click", retryLayers);
  getElement("recoverTasksButton").addEventListener("click", retryPendingTasks);
  getElement("layerTemplate").addEventListener("change", function () {
    getElement("layerList").value = AIGCLayerPlan.findTemplate(getElement("layerTemplate").value).layers.join("\n");
    saveSettings();
    refreshGuideLayers();
  });
  getElement("layerList").addEventListener("change", function () {
    saveSettings();
    refreshGuideLayers();
  });
  getElement("modelSelect").addEventListener("change", function () {
    renderSelectedModel();
    saveSettings();
  });
  getElement("prompt").addEventListener("change", saveSettings);
  getElement("guideButton").addEventListener("click", loadGuidePreview);
  getElement("guideLayer").addEventListener("change", refreshGuideLayers);
  getElement("guideBrushTool").addEventListener("click", function () { setGuideTool("brush"); });
  getElement("guideEraseTool").addEventListener("click", function () { setGuideTool("erase"); });
  getElement("guideClear").addEventListener("click", function () {
    delete guide.masks[getElement("guideLayer").value];
    redrawGuide();
  });
  getElement("guideClearAll").addEventListener("click", function () {
    guide.masks = {};
    redrawGuide();
  });
  getElement("guideCanvas").addEventListener("mousedown", function (event) {
    guide.painting = true;
    guide.last = null;
    paintGuide(guidePoint(event));
    event.preventDefault();
  });
  window.addEventListener("mousemove", function (event) {
    if (guide.painting) paintGuide(guidePoint(event));
  });
  window.addEventListener("mouseup", function () {
    guide.painting = false;
    guide.last = null;
  });
  initializeConnection(settings);
});
