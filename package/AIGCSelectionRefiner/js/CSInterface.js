function CSInterface() {}

CSInterface.prototype.getExtensionID = function () {
  return window.__adobe_cep__.getExtensionId();
};

CSInterface.prototype.dispatchEvent = function (event) {
  window.__adobe_cep__.dispatchEvent(event);
};

CSInterface.prototype.evalScript = function (script, callback) {
  window.__adobe_cep__.evalScript(script, callback || function () {});
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  window.cep.util.openURLInDefaultBrowser(url);
};

CSInterface.prototype.getExtensionPath = function () {
  var value = decodeURI(window.__adobe_cep__.getSystemPath("extension"));
  return value.replace(/^file:\/\/\//, "").replace(/^file:\/\//, "");
};
