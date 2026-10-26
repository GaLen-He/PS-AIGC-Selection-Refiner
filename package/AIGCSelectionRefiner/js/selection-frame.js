(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AIGCSelectionFrame = api;
}(this, function () {
  var ORIGINAL = "__selection_original__";

  function optionValue(item) {
    return String(item && typeof item === "object" ? (item.value !== undefined ? item.value : item.id) : item);
  }

  function ratioValue(value) {
    var parts = String(value).match(/^(\d+(?:\.\d+)?)\s*[:xX/]\s*(\d+(?:\.\d+)?)$/);
    return parts && Number(parts[1]) > 0 && Number(parts[2]) > 0 ? Number(parts[1]) / Number(parts[2]) : 0;
  }

  function fitFrame(width, height, frameWidth, frameHeight, padded) {
    var limit = Math.min(1, 8192 / frameWidth, 8192 / frameHeight, Math.sqrt(32000000 / (frameWidth * frameHeight)));
    frameWidth = Math.max(1, Math.round(frameWidth * limit));
    frameHeight = Math.max(1, Math.round(frameHeight * limit));
    var scale = padded ? limit : Math.min(frameWidth / width, frameHeight / height);
    var contentWidth = width * scale;
    var contentHeight = height * scale;
    return {
      width: frameWidth, height: frameHeight,
      left: (frameWidth - contentWidth) / 2, top: (frameHeight - contentHeight) / 2,
      contentWidth: contentWidth, contentHeight: contentHeight, padded: padded
    };
  }

  function marginSides(margin) {
    function clamp(value) { return isFinite(value) && value > 0 ? Math.min(value, 0.25) : 0; }
    if (margin && typeof margin === "object") return { x: clamp(margin.x), y: clamp(margin.y) };
    return { x: clamp(margin), y: clamp(margin) };
  }

  function resolve(parameters, parameter, width, height, margin) {
    var values = JSON.parse(JSON.stringify(parameters || {}));
    var sides = marginSides(margin);
    margin = Math.max(sides.x, sides.y);
    if (values.AspectRatio !== ORIGINAL) {
      if (!margin || !(width >= 1 && height >= 1)) return { parameters: values, frame: null };
      var fixed = ratioValue(values.AspectRatio);
      var outerWidth = width * (1 + 2 * sides.x);
      var outerHeight = height * (1 + 2 * sides.y);
      if (!fixed) return { parameters: values, frame: null };
      return { parameters: values, frame: fitFrame(width, height, Math.max(outerWidth, outerHeight * fixed), Math.max(outerWidth, outerHeight * fixed) / fixed, margin > 0) };
    }
    delete values.AspectRatio;
    if (!isFinite(width) || !isFinite(height) || width < 1 || height < 1) throw new Error("无法读取原选区尺寸，请重新创建选区。");
    var paddedWidth = width * (1 + 2 * sides.x);
    var paddedHeight = height * (1 + 2 * sides.y);
    var best = null;
    var distance = Infinity;
    var nativeValue = null;
    ((parameter && parameter.options) || []).forEach(function (item) {
      var value = optionValue(item);
      if (/^(auto|original)$/i.test(value)) nativeValue = value;
      var ratio = ratioValue(value);
      var difference = ratio ? Math.abs(Math.log(ratio / (paddedWidth / paddedHeight))) : Infinity;
      if (difference < distance) { best = value; distance = difference; }
    });
    if (nativeValue) {
      values.AspectRatio = nativeValue;
      return { parameters: values, frame: margin ? fitFrame(width, height, paddedWidth, paddedHeight, margin > 0) : null };
    }
    if (!best) {
      if (parameter) throw new Error("该模型未提供可适配的画面比例，请选择平台支持的比例或切换模型。");
      return { parameters: values, frame: margin ? fitFrame(width, height, paddedWidth, paddedHeight, margin > 0) : null };
    }
    values.AspectRatio = best;
    if (distance < 0.005 && !margin) return { parameters: values, frame: null };
    var ratio = ratioValue(best);
    var frameWidth = Math.max(paddedWidth, paddedHeight * ratio);
    return { parameters: values, frame: fitFrame(width, height, frameWidth, frameWidth / ratio, margin > 0) };
  }

  function crop(frame, width, height) {
    if (!isFinite(width) || !isFinite(height) || width < 1 || height < 1) throw new Error("返回图片尺寸无效。");
    if (Math.abs(Math.log((width / height) / (frame.width / frame.height))) > 0.02) {
      throw new Error("平台返回比例与提交比例不符，无法安全裁回原选区。已保留结果，未自动拉伸回贴。");
    }
    var scale = Math.min(width / frame.width, height / frame.height);
    return {
      left: (width - frame.width * scale) / 2 + frame.left * scale,
      top: (height - frame.height * scale) / 2 + frame.top * scale,
      width: frame.contentWidth * scale, height: frame.contentHeight * scale
    };
  }

  function snapInside(rect) {
    var left = Math.ceil(rect.left - 1e-6);
    var top = Math.ceil(rect.top - 1e-6);
    var right = Math.floor(rect.left + rect.width + 1e-6);
    var bottom = Math.floor(rect.top + rect.height + 1e-6);
    return { left: left, top: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  return { ORIGINAL: ORIGINAL, resolve: resolve, crop: crop, snapInside: snapInside };
}));
