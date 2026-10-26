function CSInterface() {}

CSInterface.prototype.registerKeyEventsInterest = function (interests) {
  if (window.__adobe_cep__.registerKeyEventsInterest) return window.__adobe_cep__.registerKeyEventsInterest(interests);
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
