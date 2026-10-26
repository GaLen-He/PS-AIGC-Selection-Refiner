const { buildGenerationPayload, fetchPlatformConfig, submitGeneration } = require("./api-client");
const { loadSettings, saveSettings } = require("./config");
const { exportSelectionAssets, insertGenerationResult } = require("./photoshop-adapter");

let platformConfig = null;

function getElement(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  getElement("status").textContent = message;
}

function setBusy(isBusy) {
  getElement("submitButton").disabled = isBusy;
  getElement("saveButton").disabled = isBusy;
  getElement("loadConfigButton").disabled = isBusy;
}

function readForm() {
  return {
    generateEndpoint: getElement("generateEndpoint").value.trim(),
    configEndpoint: getElement("configEndpoint").value.trim(),
    apiKey: getElement("apiKey").value.trim(),
    selectedModelId: getElement("modelSelect").value,
    prompt: getElement("prompt").value,
    parameters: readParameterValues()
  };
}

function writeForm(settings) {
  getElement("generateEndpoint").value = settings.generateEndpoint || settings.endpoint || "";
  getElement("configEndpoint").value = settings.configEndpoint || "";
  getElement("apiKey").value = settings.apiKey;
  getElement("modelSelect").dataset.savedModelId = settings.selectedModelId || "";
}

function saveConnectionSettings(extra = {}) {
  const form = readForm();
  saveSettings({
    generateEndpoint: form.generateEndpoint,
    configEndpoint: form.configEndpoint,
    apiKey: form.apiKey,
    selectedModelId: form.selectedModelId,
    ...extra
  });
}

function renderModels(config, preferredModelId = "") {
  const modelSelect = getElement("modelSelect");
  modelSelect.innerHTML = "";

  config.models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name;
    modelSelect.appendChild(option);
  });

  modelSelect.value = preferredModelId || config.defaultModelId || config.models[0].id;
  renderSelectedModel();
}

function renderSelectedModel() {
  const selectedModel = getSelectedModel();
  const modelDescription = getElement("modelDescription");
  const parametersPanel = getElement("parametersPanel");

  parametersPanel.innerHTML = "";

  if (!selectedModel) {
    modelDescription.textContent = "点击“读取平台配置”后显示模型。";
    return;
  }

  modelDescription.textContent = selectedModel.description || `模型 ID：${selectedModel.id}`;

  if (selectedModel.parameters.length === 0) {
    parametersPanel.textContent = "该模型没有额外参数。";
    return;
  }

  selectedModel.parameters.forEach((parameter) => {
    parametersPanel.appendChild(createParameterControl(parameter));
  });
}

function createParameterControl(parameter) {
  const label = document.createElement("label");
  label.textContent = parameter.label || parameter.name;
  const field = parameter.type === "select" ? document.createElement("select") : document.createElement("input");
  field.dataset.parameterName = parameter.name;
  field.dataset.parameterType = parameter.type;

  if (parameter.type === "select") {
    parameter.options.forEach((value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      field.appendChild(option);
    });
    field.value = String(parameter.default ?? parameter.options[0] ?? "");
  } else if (parameter.type === "boolean") {
    field.type = "checkbox";
    field.checked = Boolean(parameter.default);
  } else if (parameter.type === "number" || parameter.type === "integer") {
    field.type = "number";
    if (parameter.min !== undefined) field.min = parameter.min;
    if (parameter.max !== undefined) field.max = parameter.max;
    if (parameter.step !== undefined) field.step = parameter.step;
    field.value = parameter.default ?? "";
  } else {
    field.type = "text";
    field.value = parameter.default ?? "";
  }

  label.appendChild(field);
  return label;
}

function getSelectedModel() {
  if (!platformConfig) {
    return null;
  }

  return platformConfig.models.find((model) => model.id === getElement("modelSelect").value) || null;
}

function readParameterValues() {
  const parameters = {};

  getElement("parametersPanel").querySelectorAll("[data-parameter-name]").forEach((field) => {
    const name = field.dataset.parameterName;
    const type = field.dataset.parameterType;

    if (type === "boolean") {
      parameters[name] = field.checked;
    } else if (type === "number" || type === "integer") {
      parameters[name] = field.value === "" ? null : Number(field.value);
    } else {
      parameters[name] = field.value;
    }
  });

  return parameters;
}

async function handleLoadConfig() {
  const form = readForm();

  setBusy(true);
  setStatus("正在读取公司 AIGC 平台配置...");

  try {
    platformConfig = await fetchPlatformConfig({
      configEndpoint: form.configEndpoint,
      apiKey: form.apiKey
    });

    renderModels(platformConfig, form.selectedModelId || getElement("modelSelect").dataset.savedModelId);
    saveConnectionSettings({ selectedModelId: getElement("modelSelect").value });
    setStatus(`已读取 ${platformConfig.models.length} 个模型。请选择模型后提交选区。`);
  } catch (error) {
    setStatus(`读取配置失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function handleSubmit() {
  const form = readForm();

  setBusy(true);
  setStatus("正在读取 Photoshop 选区...");

  try {
    if (!form.selectedModelId) {
      throw new Error("请先读取平台配置并选择模型。");
    }

    saveConnectionSettings();

    const assets = await exportSelectionAssets();
    setStatus(`已导出选区 ${assets.selection.width}×${assets.selection.height}，正在提交公司 AIGC 平台...`);

    const payload = buildGenerationPayload({
      prompt: form.prompt,
      modelId: form.selectedModelId,
      imageBase64: assets.imageBase64,
      maskBase64: assets.maskBase64,
      selection: assets.selection,
      parameters: form.parameters
    });

    const result = await submitGeneration({
      endpoint: form.generateEndpoint,
      apiKey: form.apiKey,
      payload
    });

    setStatus("生成完成，正在自动放回选区...");
    await insertGenerationResult({
      result,
      selection: assets.selection,
      selectionChannelName: assets.selectionChannelName
    });

    setStatus("完成：结果已作为新图层放回原选区，并套用了选区蒙版。");
  } catch (error) {
    setStatus(`失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function handleSave() {
  saveConnectionSettings();
  setStatus("接口设置已保存。");
}

window.addEventListener("DOMContentLoaded", () => {
  writeForm(loadSettings());

  getElement("loadConfigButton").addEventListener("click", handleLoadConfig);
  getElement("modelSelect").addEventListener("change", () => {
    renderSelectedModel();
    saveConnectionSettings();
  });
  getElement("submitButton").addEventListener("click", handleSubmit);
  getElement("saveButton").addEventListener("click", handleSave);
});
