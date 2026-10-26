(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AIGCLayerPlan = api;
}(this, function () {
  var TEMPLATES = [
    { id: "character", name: "角色 / 人物", layers: ["前景特效", "角色主体", "背景"] },
    { id: "scene", name: "场景", layers: ["近景前景", "中景主体", "远景背景"] },
    { id: "product", name: "产品 / 道具", layers: ["产品主体", "背景"] },
    { id: "poster", name: "海报 / UI", layers: ["文字与装饰", "主体图像", "背景"] },
    { id: "custom", name: "自定义", layers: ["主体", "背景"] }
  ];

  function trim(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
  }

  function findTemplate(id) {
    var index;
    for (index = 0; index < TEMPLATES.length; index += 1) {
      if (TEMPLATES[index].id === id) return TEMPLATES[index];
    }
    return TEMPLATES[0];
  }

  function parseLayerList(text) {
    var seen = {};
    var layers = String(text || "").split(/\r?\n|[,，;；]/).map(trim).filter(function (name) {
      if (!name || seen[name]) return false;
      seen[name] = true;
      return true;
    });
    if (layers.length > 8) layers = layers.slice(0, 8);
    return layers;
  }

  function buildLayerJobs(layerNames, userPrompt, transparentSupported) {
    var names = (layerNames || []).filter(Boolean);
    if (names.length < 1) throw new Error("请至少填写一个图层。");
    var extra = trim(userPrompt);
    var backgroundIndex = names.length - 1;
    var jobs = [];
    var index;

    for (index = names.length - 1; index >= 0; index -= 1) {
      var name = names[index];
      var others = names.filter(function (item, otherIndex) {
        return otherIndex !== index && otherIndex !== backgroundIndex;
      });
      var lines = [];
      if (extra) lines.push(extra);
      if (index === backgroundIndex && names.length > 1) {
        lines.push("生成这张参考图的「" + name + "」纯背景层：删除画面中的" + (others.length ? others.join("、") : "所有主体元素") +
          "，并自然补全被它们遮挡的背景区域。");
        lines.push("保持原图构图、透视、光影、色调和画风完全一致，画面范围与参考图一致，不要添加任何新元素。");
        jobs.push({ name: name, kind: "background", prompt: lines.join("\n") });
      } else {
        lines.push("生成参考图中「" + name + "」的独立图层：只保留" + name + "，并完整补全它被其他元素遮挡的部分。");
        lines.push(name + "在画面中的位置、大小、姿态、透视、光影和画风必须与参考图完全一致，画面范围与参考图一致。");
        if (transparentSupported) {
          lines.push("删除其余所有内容，背景完全透明。");
        } else {
          lines.push("删除其余所有内容（包括原背景" + (others.length ? "和" + others.join("、") : "") +
            "），背景填充为纯绿色 #00FF00 平涂，无阴影、无渐变、无纹理；" + name + "本身不要使用纯绿色。");
        }
        jobs.push({ name: name, kind: "element", prompt: lines.join("\n") });
      }
    }
    return jobs;
  }

  function parseRatio(value) {
    var match = String(value || "").match(/^\s*(\d+(?:\.\d+)?)\s*[:：xX\/]\s*(\d+(?:\.\d+)?)\s*$/);
    if (!match) return 0;
    var width = Number(match[1]);
    var height = Number(match[2]);
    return width > 0 && height > 0 ? width / height : 0;
  }

  function closestAspectRatio(options, width, height) {
    var target = width > 0 && height > 0 ? width / height : 1;
    var best = null;
    var bestScore = Infinity;
    (options || []).forEach(function (option) {
      var value = option && typeof option === "object" ? option.value : option;
      var ratio = parseRatio(value);
      if (!ratio) return;
      var score = Math.abs(Math.log(ratio / target));
      if (score < bestScore) {
        bestScore = score;
        best = String(value);
      }
    });
    return best;
  }

  function hasTransparency(data) {
    var transparent = 0;
    var total = data.length / 4;
    var index;
    for (index = 3; index < data.length; index += 4) {
      if (data[index] < 250) transparent += 1;
    }
    return total > 0 && transparent / total > 0.01;
  }

  function median(values) {
    values.sort(function (a, b) { return a - b; });
    return values.length ? values[Math.floor(values.length / 2)] : 0;
  }

  function estimateKeyColor(data, width, height) {
    var red = [];
    var green = [];
    var blue = [];
    var border = Math.max(1, Math.round(Math.min(width, height) * 0.02));
    var step = Math.max(1, Math.round(Math.max(width, height) / 400));
    var x;
    var y;
    function sample(px, py) {
      var offset = (py * width + px) * 4;
      red.push(data[offset]);
      green.push(data[offset + 1]);
      blue.push(data[offset + 2]);
    }
    for (x = 0; x < width; x += step) {
      for (y = 0; y < border; y += 1) {
        sample(x, y);
        sample(x, height - 1 - y);
      }
    }
    for (y = 0; y < height; y += step) {
      for (x = 0; x < border; x += 1) {
        sample(x, y);
        sample(width - 1 - x, y);
      }
    }
    return [median(red), median(green), median(blue)];
  }

  function chromaKey(data, width, height, options) {
    var settings = options || {};
    if (hasTransparency(data)) return { keyed: false, reason: "transparent" };
    var key = settings.keyColor || estimateKeyColor(data, width, height);
    if (!settings.keyColor && (key[1] < 150 || key[1] - key[0] < 65 || key[1] - key[2] < 65)) {
      return { keyed: false, reason: "no-green-background" };
    }
    var inner = settings.inner !== undefined ? settings.inner : 48;
    var outer = settings.outer !== undefined ? settings.outer : 120;
    var index;
    for (index = 0; index < data.length; index += 4) {
      var dr = data[index] - key[0];
      var dg = data[index + 1] - key[1];
      var db = data[index + 2] - key[2];
      var distance = Math.sqrt(dr * dr + dg * dg + db * db);
      var alpha = distance <= inner ? 0 : (distance >= outer ? 1 : (distance - inner) / (outer - inner));
      if (alpha <= 0) {
        data[index + 3] = 0;
        continue;
      }
      if (alpha < 1) {
        var channel;
        for (channel = 0; channel < 3; channel += 1) {
          var unmixed = (data[index + channel] - (1 - alpha) * key[channel]) / alpha;
          data[index + channel] = Math.max(0, Math.min(255, Math.round(unmixed)));
        }
      }
      data[index + 3] = Math.round(data[index + 3] * alpha);
    }
    return { keyed: true, keyColor: key };
  }

  function markCanvasCorners(data, width, height) {
    [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]].forEach(function (point) {
      var offset = (point[1] * width + point[0]) * 4 + 3;
      if (data[offset] < 4) data[offset] = 4;
    });
  }

  function dilateMask(mask, width, height, radius) {
    var size = width * height;
    var temp = new Uint8Array(size);
    var output = new Uint8Array(size);
    var r = Math.max(0, Math.round(radius || 0));
    var x;
    var y;
    var k;
    for (y = 0; y < height; y += 1) {
      for (x = 0; x < width; x += 1) {
        var best = 0;
        for (k = Math.max(0, x - r); k <= Math.min(width - 1, x + r); k += 1) {
          if (mask[y * width + k] > best) best = mask[y * width + k];
          if (best === 255) break;
        }
        temp[y * width + x] = best;
      }
    }
    for (x = 0; x < width; x += 1) {
      for (y = 0; y < height; y += 1) {
        var top = 0;
        for (k = Math.max(0, y - r); k <= Math.min(height - 1, y + r); k += 1) {
          if (temp[k * width + x] > top) top = temp[k * width + x];
          if (top === 255) break;
        }
        output[y * width + x] = top;
      }
    }
    return output;
  }

  function opaqueRatio(data) {
    var count = 0;
    var index;
    for (index = 3; index < data.length; index += 4) {
      if (data[index] > 16) count += 1;
    }
    return data.length ? count / (data.length / 4) : 0;
  }

  function hasMaskPixels(mask) {
    var index;
    for (index = 0; index < mask.length; index += 1) {
      if (mask[index] > 8) return true;
    }
    return false;
  }

  function applyMaskAlpha(data, mask) {
    var index;
    for (index = 0; index < mask.length; index += 1) {
      data[index * 4 + 3] = Math.round(data[index * 4 + 3] * mask[index] / 255);
    }
  }

  function fillOutsideMask(data, mask, color) {
    var index;
    for (index = 0; index < mask.length; index += 1) {
      var keep = mask[index] / 255;
      var offset = index * 4;
      data[offset] = Math.round(data[offset] * keep + color[0] * (1 - keep));
      data[offset + 1] = Math.round(data[offset + 1] * keep + color[1] * (1 - keep));
      data[offset + 2] = Math.round(data[offset + 2] * keep + color[2] * (1 - keep));
      data[offset + 3] = 255;
    }
  }

  function annotateGuide(data, mask) {
    var index;
    for (index = 0; index < mask.length; index += 1) {
      var coverage = mask[index] / 255;
      var amount = coverage * 0.38;
      var brightness = 0.35 + coverage * 0.65;
      var offset = index * 4;
      data[offset] = Math.round(data[offset] * brightness * (1 - amount) + 255 * amount);
      data[offset + 1] = Math.round(data[offset + 1] * brightness * (1 - amount) + 40 * amount);
      data[offset + 2] = Math.round(data[offset + 2] * brightness * (1 - amount) + 160 * amount);
    }
  }

  function guidedPrompt(name, transparentSupported, extra) {
    return "涂抹区域优先：只提取参考图中粉色涂抹覆盖的对象或表面，这是唯一的目标定位依据。" +
      "名称「" + name + "」仅用于命名图层，不能用名称猜测或替换目标；例如涂地面就提取地面，不能改成角色。" +
      "暗色的未涂区域仅供理解场景，不是本层目标；识别涂抹内部的真实边界并完整补全同一目标的连接部分，不能把邻近未涂的其他物体带入。" +
      "不要把粗略笔触当成硬裁切边界；去掉粉色提示并恢复原有材质颜色、光影和画风。" +
      "输出画幅必须与所给参考图一致，目标在该画幅内的位置和比例保持不变，不要居中、放大或缩小目标，不要重新构图。" +
      (transparentSupported ? "其余区域完全透明。" : "其余区域填纯绿色 #00FF00，无纹理、渐变或阴影；目标本身不要用此纯绿色。") +
      (trim(extra) ? "以下补充只用于画风细节，不得改变涂抹所选目标：" + trim(extra) : "");
  }

  function guideGeometry(mask, maskWidth, maskHeight, sourceWidth, sourceHeight, ratios) {
    var minColumn = maskWidth;
    var minRow = maskHeight;
    var maxColumn = -1;
    var maxRow = -1;
    var index;
    for (index = 0; index < mask.length; index += 1) {
      if (mask[index] <= 8) continue;
      var column = index % maskWidth;
      var row = Math.floor(index / maskWidth);
      minColumn = Math.min(minColumn, column);
      maxColumn = Math.max(maxColumn, column);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
    }
    if (maxColumn < 0) return null;
    var left = minColumn * sourceWidth / maskWidth;
    var right = (maxColumn + 1) * sourceWidth / maskWidth;
    var top = minRow * sourceHeight / maskHeight;
    var bottom = (maxRow + 1) * sourceHeight / maskHeight;
    var minimumPadding = Math.min(sourceWidth, sourceHeight) * 0.02;
    var paddingWidth = Math.max((right - left) * 0.2, minimumPadding);
    var paddingHeight = Math.max((bottom - top) * 0.2, minimumPadding);
    left = Math.max(0, left - paddingWidth);
    right = Math.min(sourceWidth, right + paddingWidth);
    top = Math.max(0, top - paddingHeight);
    bottom = Math.min(sourceHeight, bottom + paddingHeight);
    var width = right - left;
    var height = bottom - top;
    var ratio = closestAspectRatio(ratios, width, height);
    var aspect = parseRatio(ratio);
    if (aspect > 0) {
      if (width / height < aspect) width = height * aspect;
      else height = width / aspect;
    }
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    left = Math.round((left + right - width) / 2);
    top = Math.round((top + bottom - height) / 2);
    return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height, ratio: ratio };
  }

  function containGeometry(width, height, targetWidth, targetHeight) {
    var scale = Math.min(targetWidth / width, targetHeight / height);
    var fittedWidth = Math.max(1, Math.round(width * scale));
    var fittedHeight = Math.max(1, Math.round(height * scale));
    return { left: Math.floor((targetWidth - fittedWidth) / 2), top: Math.floor((targetHeight - fittedHeight) / 2), width: fittedWidth, height: fittedHeight };
  }

  function mapHealRegions(regions, fit, width, height) {
    return (regions || []).map(function (region) {
      return {
        left: (fit.left + region.left * fit.width) / width,
        top: (fit.top + region.top * fit.height) / height,
        right: (fit.left + region.right * fit.width) / width,
        bottom: (fit.top + region.bottom * fit.height) / height
      };
    });
  }

  function runPool(items, limit, worker) {
    var list = items || [];
    var results = new Array(list.length);
    var next = 0;
    var count = Math.max(1, Math.min(limit || 1, list.length));
    function lane() {
      if (next >= list.length) return Promise.resolve();
      var current = next;
      next += 1;
      return Promise.resolve().then(function () {
        return worker(list[current], current);
      }).then(function (value) {
        results[current] = value;
      }).then(lane);
    }
    var lanes = [];
    var index;
    for (index = 0; index < count; index += 1) lanes.push(lane());
    return Promise.all(lanes).then(function () { return results; });
  }

  return {
    opaqueRatio: opaqueRatio,
    dilateMask: dilateMask,
    hasMaskPixels: hasMaskPixels,
    applyMaskAlpha: applyMaskAlpha,
    fillOutsideMask: fillOutsideMask,
    guidedPrompt: guidedPrompt,
    guideGeometry: guideGeometry,
    containGeometry: containGeometry,
    mapHealRegions: mapHealRegions,
    annotateGuide: annotateGuide,
    runPool: runPool,
    markCanvasCorners: markCanvasCorners,
    TEMPLATES: TEMPLATES,
    findTemplate: findTemplate,
    parseLayerList: parseLayerList,
    buildLayerJobs: buildLayerJobs,
    closestAspectRatio: closestAspectRatio,
    hasTransparency: hasTransparency,
    estimateKeyColor: estimateKeyColor,
    chromaKey: chromaKey
  };
}));
