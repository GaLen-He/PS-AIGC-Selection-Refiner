(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIGCStudioCatalog = api;
}(this, function () {
  "use strict";

  function readConstant(source, name) {
    var match = new RegExp("(?:^|\\n)[ \\t]*(?:const|let|var)\\s+" + name + "\\s*=\\s*").exec(source);
    var cursor = match ? match.index + match[0].length : 0;
    var count = 0;

    function fail() {
      throw new Error("平台创作台配置无法解析（" + name + "），请重新连接或更新插件。");
    }

    function skip() {
      var end;
      while (cursor < source.length) {
        if (/\s/.test(source.charAt(cursor))) cursor += 1;
        else if (source.substr(cursor, 2) === "//") {
          end = source.indexOf("\n", cursor + 2);
          cursor = end < 0 ? source.length : end + 1;
        } else if (source.substr(cursor, 2) === "/*") {
          end = source.indexOf("*/", cursor + 2);
          if (end < 0) fail();
          cursor = end + 2;
        } else break;
      }
    }

    function readString() {
      var quote = source.charAt(cursor++);
      var text = "";
      var character;
      var digits;
      var escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
      while (cursor < source.length && text.length < 4096) {
        character = source.charAt(cursor++);
        if (character === quote) return text;
        if (character === "\n" || character === "\r") fail();
        if (character === "\\") {
          character = source.charAt(cursor++);
          if (character === "u" || character === "x") {
            digits = source.substr(cursor, character === "u" ? 4 : 2);
            if (!/^[0-9a-f]+$/i.test(digits) || digits.length !== (character === "u" ? 4 : 2)) fail();
            text += String.fromCharCode(parseInt(digits, 16));
            cursor += digits.length;
          } else if (Object.prototype.hasOwnProperty.call(escapes, character)) text += escapes[character];
          else if (character === "\\" || character === "'" || character === '"' || character === "/") text += character;
          else fail();
        } else text += character;
      }
      fail();
    }

    function readValue(depth) {
      var character;
      var array;
      var result;
      var close;
      var key;
      var token;
      count += 1;
      if (depth > 24 || count > 20000) fail();
      skip();
      character = source.charAt(cursor);
      if (character === "'" || character === '"') return readString();
      if (character === "{" || character === "[") {
        array = character === "[";
        result = array ? [] : Object.create(null);
        close = array ? "]" : "}";
        cursor += 1;
        skip();
        while (source.charAt(cursor) !== close) {
          if (array) result.push(readValue(depth + 1));
          else {
            character = source.charAt(cursor);
            if (character === "'" || character === '"') key = readString();
            else {
              token = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor));
              if (!token) fail();
              key = token[0];
              cursor += key.length;
            }
            if (["__proto__", "prototype", "constructor"].indexOf(key) >= 0) fail();
            skip();
            if (source.charAt(cursor++) !== ":") fail();
            result[key] = readValue(depth + 1);
          }
          skip();
          if (source.charAt(cursor) === close) break;
          if (source.charAt(cursor++) !== ",") fail();
          skip();
        }
        cursor += 1;
        return result;
      }
      token = /^(true|false|null)\b|^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(cursor));
      if (!token) fail();
      cursor += token[0].length;
      return JSON.parse(token[0]);
    }

    if (!match) fail();
    var value = readValue(0);
    skip();
    if (source.charAt(cursor) !== ";") fail();
    return value;
  }

  function authorizedImageIds(payload) {
    var ids = [];
    if (!payload || !Array.isArray(payload.groups)) throw new Error("平台模型列表返回格式已变化，请重新连接或更新插件。");
    payload.groups.forEach(function (group) {
      if (!group || group.model_type !== "image") return;
      if (!Array.isArray(group.models)) throw new Error("平台模型列表返回格式已变化，请重新连接或更新插件。");
      group.models.forEach(function (id) {
        if (typeof id !== "string" || !id) throw new Error("平台模型列表返回格式已变化，请更新插件。");
        if (ids.indexOf(id) < 0) ids.push(id);
      });
    });
    return ids;
  }

  function parseStudioCatalog(source, payload) {
    var authorized = authorizedImageIds(payload);
    var maps = {};
    var models = [];
    if (typeof source !== "string" || source.length > 4 * 1024 * 1024) throw new Error("平台创作台配置大小异常。");
    ["IMAGE_MODELS", "IMAGE_VERSION_LABELS", "IMAGE_RESOLUTIONS_MAP", "IMAGE_RESOLUTIONS_DEFAULT", "IMAGE_ASPECT_RATIOS", "IMAGE_DEFAULTS", "IMAGE_QUALITIES", "IMAGE_BACKGROUNDS", "IMAGE_BACKGROUND_LABELS"].forEach(function (name) {
      maps[name] = readConstant(source, name);
      if (!maps[name] || typeof maps[name] !== "object") throw new Error("平台创作台配置格式异常（" + name + "）。");
    });
    Object.keys(maps.IMAGE_MODELS).forEach(function (family) {
      var info = maps.IMAGE_MODELS[family];
      if (!info || !Array.isArray(info.versions)) throw new Error("平台生图模型配置格式异常。");
      info.versions.forEach(function (version) {
        var id = (info.modelKeyPrefix || family) + "-" + version;
        var key = family + ":" + version;
        var defaults = maps.IMAGE_DEFAULTS[key] || {};
        var parameters = [];
        if (authorized.indexOf(id) < 0 || models.some(function (model) { return model.id === id; })) return;
        [
          ["Resolution", "分辨率", "IMAGE_RESOLUTIONS_MAP", "resolution"],
          ["AspectRatio", "画面比例", "IMAGE_ASPECT_RATIOS", "aspectRatio"],
          ["Quality", "画质", "IMAGE_QUALITIES", "quality"],
          ["Background", "背景", "IMAGE_BACKGROUNDS", "background"]
        ].forEach(function (field) {
          var values = maps[field[2]][key];
          var defaultValue;
          if (field[0] === "Resolution" && family === "Midjourney") return;
          if (values === undefined) values = field[0] === "Resolution" ? maps.IMAGE_RESOLUTIONS_DEFAULT : [];
          if (!Array.isArray(values) || values.some(function (value) { return typeof value !== "string"; })) throw new Error("平台模型参数配置格式异常（" + id + "）。");
          if (!values.length) return;
          defaultValue = values.indexOf(defaults[field[3]]) >= 0 ? defaults[field[3]] : values[0];
          parameters.push({
            name: field[0], label: field[1], type: "select", default: defaultValue,
            options: values.map(function (value) {
              return { value: value, label: field[0] === "Background" ? (maps.IMAGE_BACKGROUND_LABELS[value] || value) : value };
            })
          });
        });
        models.push({ id: id, name: String(maps.IMAGE_VERSION_LABELS[key] || ((info.label || family) + " " + version)), description: "", parameters: parameters });
      });
    });
    if (authorized.length && !models.length) throw new Error("Key 已有生图权限，但创作台没有匹配的选区生图模型配置，请更新插件。");
    return models;
  }

  function findStudioScript(studioUrl, html) {
    var URL = require("url").URL;
    var base = new URL(studioUrl);
    var pattern = /<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi;
    var match;
    var resolved;
    var parsed;
    while ((match = pattern.exec(html))) {
      try {
        parsed = new URL(match[2].replace(/&amp;/g, "&"), studioUrl);
      } catch (error) {
        continue;
      }
      resolved = parsed.href;
      if (/\/aigc\/assets\/aigc(?:[.-][0-9a-f]{6,})?\.js$/i.test(parsed.pathname) && parsed.origin === base.origin && !parsed.username && !parsed.password) return resolved;
    }
    throw new Error("未找到同一平台的生图配置文件，请检查供应商 URL 或更新插件。");
  }

  return { authorizedImageIds: authorizedImageIds, parseStudioCatalog: parseStudioCatalog, findStudioScript: findStudioScript };
}));
