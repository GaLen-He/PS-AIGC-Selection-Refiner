const STORAGE_KEY = "ps-aigc-selection-refiner-settings";

const defaultSettings = {
  generateEndpoint: "http://localhost:3000/api/generate",
  configEndpoint: "http://localhost:3000/api/config",
  apiKey: "",
  selectedModelId: "",
  strength: 0.65
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...defaultSettings, ...saved };
  } catch (_) {
    return { ...defaultSettings };
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...defaultSettings, ...settings }));
}

module.exports = {
  defaultSettings,
  loadSettings,
  saveSettings
};
