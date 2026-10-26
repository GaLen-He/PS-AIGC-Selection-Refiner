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

  function resolve(parameters, parameter, width, height) {
    var values = JSON.parse(JSON.stringify(parameters || {}));
    if (values.AspectRatio !== ORIGINAL) return { parameters: values, frame: null };
    delete values.AspectRatio;
    if (!isFinite(width) || !isFinite(height) || width < 1 || height < 1) throw new Error("无法读取原选区尺寸，请重新创建选区。");
    var best = null;
    var distance = Infinity;
    var nativeValue = null;
    ((parameter && parameter.options) || []).forEach(function (item) {
      var value = optionValue(item);
      if (/^(auto|original)$/i.test(value)) nativeValue = value;
      var ratio = ratioValue(value);
      var difference = ratio ? Math.abs(Math.log(ratio / (width / height))) : Infinity;
      if (difference < distance) { best = value; distance = difference; }
    });
    if (nativeValue) {
      values.AspectRatio = nativeValue;
      return { parameters: values, frame: null };
    }
    if (!best) {
      if (parameter) throw new Error("该模型未提供可适配的画面比例，请选择平台支持的比例或切换模型。");
      return { parameters: values, frame: null };
    }
    values.AspectRatio = best;
    if (distance < 0.005) return { parameters: values, frame: null };
    var ratio = ratioValue(best);
    var frameWidth = Math.max(width, height * ratio);
    var frameHeight = frameWidth / ratio;
    var limit = Math.min(1, 8192 / frameWidth, 8192 / frameHeight, Math.sqrt(32000000 / (frameWidth * frameHeight)));
    frameWidth = Math.max(1, Math.round(frameWidth * limit));
    frameHeight = Math.max(1, Math.round(frameHeight * limit));
    var scale = Math.min(frameWidth / width, frameHeight / height);
    var contentWidth = width * scale;
    var contentHeight = height * scale;
    return { parameters: values, frame: {
      width: frameWidth, height: frameHeight,
      left: (frameWidth - contentWidth) / 2, top: (frameHeight - contentHeight) / 2,
      contentWidth: contentWidth, contentHeight: contentHeight
    } };
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

  return { ORIGINAL: ORIGINAL, resolve: resolve, crop: crop };
}));
