var AIGCSelectionRefiner = AIGCSelectionRefiner || {};

(function () {
  function quote(text) {
    var output = "\"";
    var index;
    for (index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      var character = text.charAt(index);
      if (character === "\"" || character === "\\") {
        output += "\\" + character;
      } else if (code < 32 || code > 126) {
        var hex = code.toString(16);
        while (hex.length < 4) hex = "0" + hex;
        output += "\\u" + hex;
      } else {
        output += character;
      }
    }
    return output + "\"";
  }

  function stringify(value) {
    if (value === null || value === undefined) return "null";
    var kind = typeof value;
    if (kind === "number") return isFinite(value) ? String(value) : "null";
    if (kind === "boolean") return value ? "true" : "false";
    if (kind === "string") return quote(value);
    if (Object.prototype.toString.call(value) === "[object Array]") {
      var items = [];
      var index;
      for (index = 0; index < value.length; index += 1) items.push(stringify(value[index]));
      return "[" + items.join(",") + "]";
    }
    var parts = [];
    var key;
    for (key in value) {
      if (value.hasOwnProperty(key) && typeof value[key] !== "function") {
        parts.push(quote(String(key)) + ":" + stringify(value[key]));
      }
    }
    return "{" + parts.join(",") + "}";
  }

  AIGCSelectionRefiner._stringify = stringify;

  function ok(data) {
    return stringify({ ok: true, data: data });
  }

  function fail(error) {
    var message = error && error.message ? error.message : String(error);
    if (error && error.line) message += "（line " + error.line + "）";
    return stringify({ ok: false, error: message });
  }

  function cTID(value) {
    return charIDToTypeID(value);
  }

  function sTID(value) {
    return stringIDToTypeID(value);
  }

  function useAcceleratedPlayback() {
    try {
      var descriptor = new ActionDescriptor();
      var reference = new ActionReference();
      reference.putProperty(cTID("Prpr"), cTID("PbkO"));
      reference.putEnumerated(cTID("capp"), cTID("Ordn"), cTID("Trgt"));
      descriptor.putReference(cTID("null"), reference);
      var options = new ActionDescriptor();
      options.putEnumerated(sTID("performance"), sTID("performance"), sTID("accelerated"));
      descriptor.putObject(cTID("T   "), cTID("PbkO"), options);
      executeAction(cTID("setd"), descriptor, DialogModes.NO);
    } catch (error) {}
  }

  function px(value) {
    return Number(value.as ? value.as("px") : value);
  }

  function getSelectionBounds() {
    var bounds = app.activeDocument.selection.bounds;
    var left = Math.round(px(bounds[0]));
    var top = Math.round(px(bounds[1]));
    var right = Math.round(px(bounds[2]));
    var bottom = Math.round(px(bounds[3]));
    var width = right - left;
    var height = bottom - top;

    if (width <= 0 || height <= 0) {
      throw new Error("请先在 Photoshop 里创建一个有效选区。");
    }

    return { left: left, top: top, right: right, bottom: bottom, width: width, height: height };
  }

  function selectRectangle(selection) {
    app.activeDocument.selection.select([
      [selection.left, selection.top],
      [selection.right, selection.top],
      [selection.right, selection.bottom],
      [selection.left, selection.bottom]
    ]);
  }

  var pendingExport = null;

  AIGCSelectionRefiner._exportInternal = function () {
    var job = pendingExport;
    try {
      var selection = job.selection;
      var document = app.activeDocument;
      if (selection) {
        document.flatten();
        document.crop([selection.left, selection.top, selection.right, selection.bottom]);
      }
      normalizeForUpload(document);
      savePng(document, job.file);
    } catch (error) {
      job.error = error;
    }
  };

  function exportCroppedInPlace(document, selection, file) {
    var canvas = documentBounds(document);
    var crop = selection || { left: 0, top: 0, width: canvas.width, height: canvas.height };
    var hasArtboards = false;
    var index;
    for (index = 0; index < document.layerSets.length; index += 1) {
      if (isArtboard(document.layerSets[index])) { hasArtboards = true; break; }
    }
    if (!hasArtboards && document.mode === DocumentMode.RGB && document.bitsPerChannel === BitsPerChannelType.EIGHT &&
        canvas.width <= 8192 && canvas.height <= 8192 && canvas.width * canvas.height <= 16777216 &&
        crop.left >= 0 && crop.top >= 0 && crop.left + crop.width <= canvas.width && crop.top + crop.height <= canvas.height) {
      try {
        var options = new ExportOptionsSaveForWeb();
        options.format = SaveDocumentType.PNG;
        options.PNG8 = false;
        options.transparency = false;
        options.interlaced = false;
        options.includeProfile = true;
        document.exportDocument(file, ExportType.SAVEFORWEB, options);
        return {
          canvas: { width: canvas.width, height: canvas.height },
          crop: { left: crop.left, top: crop.top, width: crop.width, height: crop.height },
          maxSize: 2048
        };
      } catch (exportError) {}
    }
    var previousUnits = app.preferences.rulerUnits;
    var savedState = document.activeHistoryState;
    var job = { selection: selection, file: file };
    try {
      app.preferences.rulerUnits = Units.PIXELS;
      pendingExport = job;
      document.suspendHistory("AIGC 导出", "AIGCSelectionRefiner._exportInternal()");
    } finally {
      pendingExport = null;
      try {
        document.activeHistoryState = savedState;
      } catch (restoreError) {}
      app.preferences.rulerUnits = previousUnits;
    }
    if (job.error) throw job.error;
    return null;
  }

  function duplicateMergedDocument(name) {
    var sourceDocument = app.activeDocument;
    var previousUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    var newDoc = sourceDocument.duplicate(name, true);
    app.preferences.rulerUnits = previousUnits;
    return newDoc;
  }

  function savePng(document, file) {
    var options = new PNGSaveOptions();
    options.interlaced = false;
    document.saveAs(file, options, true, Extension.LOWERCASE);
  }

  function normalizeForUpload(document) {
    try {
      document.flatten();
    } catch (flattenError) {}
    if (document.mode !== DocumentMode.RGB) {
      document.changeMode(ChangeMode.RGB);
    }
    if (document.bitsPerChannel !== BitsPerChannelType.EIGHT) {
      document.bitsPerChannel = BitsPerChannelType.EIGHT;
    }
    try {
      document.convertProfile("sRGB IEC61966-2.1", Intent.RELATIVECOLORIMETRIC, true, false);
    } catch (profileError) {}
    var width = Math.round(px(document.width));
    var height = Math.round(px(document.height));
    var longest = Math.max(width, height);
    if (longest > 2048) {
      var scale = 2048 / longest;
      document.resizeImage(UnitValue(Math.max(1, Math.round(width * scale)), "px"),
        UnitValue(Math.max(1, Math.round(height * scale)), "px"), null, ResampleMethod.BICUBIC);
    }
  }

  function makeRevealSelectionMask() {
    var descriptor = new ActionDescriptor();
    var reference = new ActionReference();
    descriptor.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
    reference.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
    descriptor.putReference(charIDToTypeID("At  "), reference);
    descriptor.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), charIDToTypeID("RvlS"));
    executeAction(charIDToTypeID("Mk  "), descriptor, DialogModes.NO);
  }

  function placeFile(file) {
    var descriptor = new ActionDescriptor();
    descriptor.putPath(charIDToTypeID("null"), file);
    descriptor.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
    executeAction(charIDToTypeID("Plc "), descriptor, DialogModes.NO);
  }

  function layerBounds(layer) {
    var bounds = layer.bounds;
    var left = Math.round(px(bounds[0]));
    var top = Math.round(px(bounds[1]));
    var right = Math.round(px(bounds[2]));
    var bottom = Math.round(px(bounds[3]));
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  function smartObjectBounds() {
    try {
      var reference = new ActionReference();
      reference.putEnumerated(sTID("layer"), sTID("ordinal"), sTID("targetEnum"));
      var descriptor = executeActionGet(reference);
      var more = descriptor.getObjectValue(sTID("smartObjectMore"));
      var corners = more.getList(sTID("transform"));
      if (corners.count < 8) return null;
      var xs = [];
      var ys = [];
      var index;
      for (index = 0; index < 8; index += 2) {
        xs.push(corners.getDouble(index));
        ys.push(corners.getDouble(index + 1));
      }
      var left = Math.min(xs[0], xs[1], xs[2], xs[3]);
      var right = Math.max(xs[0], xs[1], xs[2], xs[3]);
      var top = Math.min(ys[0], ys[1], ys[2], ys[3]);
      var bottom = Math.max(ys[0], ys[1], ys[2], ys[3]);
      if (right - left < 1 || bottom - top < 1) return null;
      return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
    } catch (error) {
      return null;
    }
  }

  function placedBounds(layer) {
    return smartObjectBounds() || layerBounds(layer);
  }

  function resizeAndMoveLayer(layer, target) {
    var bounds = placedBounds(layer);
    if (target.width > 0 && target.height > 0 && bounds.width > 0 && bounds.height > 0 &&
      (Math.abs(bounds.width - target.width) > 0.5 || Math.abs(bounds.height - target.height) > 0.5)) {
      layer.resize((target.width / bounds.width) * 100, (target.height / bounds.height) * 100, AnchorPosition.MIDDLECENTER);
      bounds = placedBounds(layer);
    }
    var dx = target.left - bounds.left;
    var dy = target.top - bounds.top;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) layer.translate(dx, dy);
  }

  function withPixelUnits(callback) {
    var previousUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    try {
      return callback();
    } finally {
      app.preferences.rulerUnits = previousUnits;
    }
  }

  function validateSourceDimensions(source) {
    if (!source) return;
    var current = documentBounds(app.activeDocument);
    if (current.width !== source.width || current.height !== source.height) {
      throw new Error("原 PSD 画布尺寸已变化，已停止回填以免错位。请恢复提交时的尺寸再取回。");
    }
  }

  function placementTarget(info, canvas) {
    var target = info.target || canvas;
    if (!isFinite(target.left) || !isFinite(target.top) || !isFinite(target.width) || !isFinite(target.height) ||
      target.width <= 0 || target.height <= 0) throw new Error("图层定位信息无效，已停止回填。");
    if (!info.unprocessed) return target;
    var bounds = placedBounds(app.activeDocument.activeLayer);
    var scale = Math.min(target.width / bounds.width, target.height / bounds.height);
    var width = bounds.width * scale;
    var height = bounds.height * scale;
    return { left: target.left + (target.width - width) / 2, top: target.top + (target.height - height) / 2, width: width, height: height };
  }

  function activeDocumentId() {
    var reference = new ActionReference();
    reference.putProperty(cTID("Prpr"), sTID("documentID"));
    reference.putEnumerated(cTID("Dcmn"), cTID("Ordn"), cTID("Trgt"));
    var identity = executeActionGet(reference).getInteger(sTID("documentID"));
    if (!(identity > 0)) throw new Error("无法读取原文档标识，已停止以免回错项目。");
    return identity;
  }

  function activateDocument(documentId) {
    if (!app.documents.length) throw new Error("请先打开一个 Photoshop 文档。");
    var previous = app.activeDocument;
    var identity = Number(documentId);
    if (!isFinite(identity) || identity <= 0 || Math.floor(identity) !== identity) throw new Error("任务缺少有效的原文档标识，请重新提交；不会使用当前文档。");
    if (activeDocumentId() === identity) return null;
    try {
      var reference = new ActionReference();
      reference.putIdentifier(cTID("Dcmn"), identity);
      var descriptor = new ActionDescriptor();
      descriptor.putReference(cTID("null"), reference);
      executeAction(cTID("slct"), descriptor, DialogModes.NO);
      if (activeDocumentId() !== identity) throw new Error("document mismatch");
      return previous;
    } catch (error) {
      restoreDocument(previous);
      throw new Error("提交任务的原文档已关闭或不可用，结果不会放入其他文档。");
    }
  }

  function restoreDocument(previous) {
    try {
      if (previous) app.activeDocument = previous;
    } catch (restoreError) {}
  }

  function documentBounds(document) {
    var width = Math.round(px(document.width));
    var height = Math.round(px(document.height));
    return { left: 0, top: 0, right: width, bottom: height, width: width, height: height };
  }

  function layerIdentity(layer) {
    try {
      var identity = Number(layer.id);
      return isFinite(identity) && identity > 0 ? identity : 0;
    } catch (error) {
      return 0;
    }
  }

  function isArtboard(layer) {
    if (!layer || layer.typename !== "LayerSet") return false;
    try {
      if (layer.artboardEnabled === true) return true;
    } catch (propertyError) {}
    try {
      var identity = layerIdentity(layer);
      if (!identity) return false;
      var reference = new ActionReference();
      reference.putIdentifier(sTID("layer"), identity);
      return executeActionGet(reference).hasKey(sTID("artboard"));
    } catch (descriptorError) {
      return false;
    }
  }

  function artboardBounds(layer) {
    try {
      var identity = layerIdentity(layer);
      if (!identity) throw new Error("missing artboard identity");
      var reference = new ActionReference();
      reference.putIdentifier(sTID("layer"), identity);
      var descriptor = executeActionGet(reference);
      var artboard = descriptor.getObjectValue(sTID("artboard"));
      var rectangle = artboard.getObjectValue(sTID("artboardRect"));
      var left = rectangle.getUnitDoubleValue(sTID("left"));
      var top = rectangle.getUnitDoubleValue(sTID("top"));
      var right = rectangle.getUnitDoubleValue(sTID("right"));
      var bottom = rectangle.getUnitDoubleValue(sTID("bottom"));
      return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
    } catch (error) {
      return layerBounds(layer);
    }
  }

  function intersectionArea(first, second) {
    var width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
    var height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
    return width * height;
  }

  function captureActiveArtboard(document) {
    if (!document.layerSets || !document.layerSets.length) return null;
    var selection = getSelectionBounds();
    var best = null;
    var bestArea = 0;
    var index;
    for (index = 0; index < document.layerSets.length; index += 1) {
      var candidate = document.layerSets[index];
      if (!isArtboard(candidate)) continue;
      var area = intersectionArea(selection, artboardBounds(candidate));
      if (area > bestArea) {
        best = candidate;
        bestArea = area;
      }
    }
    if (!best || bestArea <= 0) return null;
    return { id: layerIdentity(best), name: best.name };
  }

  function findArtboard(document, info) {
    if (!info || !document.layerSets || !document.layerSets.length) return null;
    var identity = Number(info.id);
    var index;
    var nameMatch = null;
    for (index = 0; index < document.layerSets.length; index += 1) {
      var candidate = document.layerSets[index];
      if (!isArtboard(candidate)) continue;
      if (identity > 0 && layerIdentity(candidate) === identity) return candidate;
      if (!nameMatch && candidate.name === info.name) nameMatch = candidate;
    }
    return nameMatch;
  }

  var selectionSnapshotCounter = 0;

  AIGCSelectionRefiner.exportSelection = function () {
    var previousDialogMode = app.displayDialogs;
    var sourceDocument = null;
    var selectionChannelName = "";
    var sourceChannels = null;
    var tempFile = null;
    try {
      if (!app.documents.length) {
        throw new Error("请先打开一个 Photoshop 文档。");
      }

      app.displayDialogs = DialogModes.NO;
      useAcceleratedPlayback();
      sourceDocument = app.activeDocument;
      var documentId = activeDocumentId();
      var selection = getSelectionBounds();
      var artboard = captureActiveArtboard(sourceDocument);
      sourceChannels = sourceDocument.activeChannels;
      selectionSnapshotCounter += 1;
      selectionChannelName = "AIGC_selection_" + new Date().getTime() + "_" + selectionSnapshotCounter;
      var snapshot = sourceDocument.channels.add();
      snapshot.name = selectionChannelName;
      sourceDocument.selection.store(snapshot);
      sourceDocument.activeChannels = sourceChannels;
      tempFile = new File(Folder.temp.fsName + "/aigc-selection-" + new Date().getTime() + "-" + selectionSnapshotCounter + ".png");
      var imagePreparation = exportCroppedInPlace(sourceDocument, selection, tempFile);
      app.displayDialogs = previousDialogMode;

      return ok({
        imagePath: tempFile.fsName,
        imagePreparation: imagePreparation,
        selection: selection,
        selectionChannelName: selectionChannelName,
        documentId: documentId,
        documentName: sourceDocument.name,
        source: documentBounds(sourceDocument),
        artboard: artboard
      });
    } catch (error) {
      if (sourceDocument && selectionChannelName) {
        try { sourceDocument.channels.getByName(selectionChannelName).remove(); } catch (removeError) {}
      }
      if (tempFile) {
        try { if (tempFile.exists) tempFile.remove(); } catch (fileError) {}
      }
      try {
        app.displayDialogs = previousDialogMode;
      } catch (dialogError) {}
      return fail(error);
    } finally {
      if (sourceDocument && sourceChannels) {
        try { sourceDocument.activeChannels = sourceChannels; } catch (channelError) {}
      }
    }
  };

  AIGCSelectionRefiner.exportDocument = function (documentId) {
    var previousDialogMode;
    var sourceDocument;
    var tempFile;
    var exportDocument;
    var previousDocument = null;

    try {
      if (!app.documents.length) {
        throw new Error("请先打开一个 Photoshop 文档。");
      }

      if (documentId !== undefined && documentId !== null) previousDocument = activateDocument(documentId);
      sourceDocument = app.activeDocument;
      var sourceId = activeDocumentId();
      tempFile = new File(Folder.temp.fsName + "/aigc-source-" + new Date().getTime() + ".png");
      previousDialogMode = app.displayDialogs;
      app.displayDialogs = DialogModes.NO;
      useAcceleratedPlayback();
      var sourceInfo = documentBounds(sourceDocument);
      var imagePreparation = exportCroppedInPlace(sourceDocument, null, tempFile);
      app.displayDialogs = previousDialogMode;

      return ok({
        imagePath: tempFile.fsName,
        imagePreparation: imagePreparation,
        source: sourceInfo,
        documentId: sourceId,
        documentName: sourceDocument.name
      });
    } catch (error) {
      try {
        if (exportDocument) exportDocument.close(SaveOptions.DONOTSAVECHANGES);
      } catch (closeError) {}
      try {
        if (previousDialogMode) app.displayDialogs = previousDialogMode;
      } catch (dialogError) {}
      try {
        if (sourceDocument) app.activeDocument = sourceDocument;
      } catch (activeError) {}
      return fail(error);
    } finally {
      restoreDocument(previousDocument);
    }
  };

  var pendingPlacement = null;

  function selectionResultName(taskId) {
    var value = String(taskId || "");
    return "AIGC 平台返回结果" + (value ? " · " + value.slice(-10) : "");
  }

  function findNamedLayer(container, name) {
    var layers = container && container.layers;
    var index;
    var found;
    if (!layers) return null;
    for (index = 0; index < layers.length; index += 1) {
      if (layers[index].name === name) return layers[index];
      if (layers[index].layers) {
        found = findNamedLayer(layers[index], name);
        if (found) return found;
      }
    }
    return null;
  }

  function healResultRegions(layer, regions, target) {
    var warnings = [];
    if (!regions || !regions.length) return warnings;
    var document = app.activeDocument;
    var savedChannel = null;
    var savedChannels = document.activeChannels;
    var savedTransparencyLock = null;
    var selectionChanged = false;
    try {
      var hasSelection = false;
      try { hasSelection = !!document.selection.bounds; } catch (noSelection) {}
      if (hasSelection) {
        savedChannel = document.channels.add();
        document.selection.store(savedChannel);
      }
      document.activeLayer = layer;
      document.activeChannels = document.componentChannels;
      var rectangles = [];
      var index;
      for (index = 0; index < regions.length; index += 1) {
        var region = regions[index];
        if (!region || !isFinite(region.left) || !isFinite(region.top) || !isFinite(region.right) || !isFinite(region.bottom)) continue;
        var left = Math.max(0, Math.min(1, region.left));
        var top = Math.max(0, Math.min(1, region.top));
        var right = Math.max(0, Math.min(1, region.right));
        var bottom = Math.max(0, Math.min(1, region.bottom));
        if (right <= left || bottom <= top || right - left > 0.2 || bottom - top > 0.15) continue;
        rectangles.push({
          left: target.left + Math.floor(left * target.width),
          top: target.top + Math.floor(top * target.height),
          right: target.left + Math.ceil(right * target.width),
          bottom: target.top + Math.ceil(bottom * target.height)
        });
      }
      if (!rectangles.length) return warnings;
      if (layer.kind !== LayerKind.NORMAL) layer.rasterize(RasterizeType.ENTIRELAYER);
      savedTransparencyLock = layer.transparentPixelsLocked;
      layer.transparentPixelsLocked = false;
      for (index = 0; index < rectangles.length; index += 1) {
        try {
          selectionChanged = true;
          var transparencyDescriptor = new ActionDescriptor();
          var selectionReference = new ActionReference();
          selectionReference.putProperty(cTID("Chnl"), cTID("fsel"));
          transparencyDescriptor.putReference(cTID("null"), selectionReference);
          var transparencyReference = new ActionReference();
          transparencyReference.putEnumerated(cTID("Chnl"), cTID("Chnl"), cTID("Trsp"));
          transparencyDescriptor.putReference(cTID("T   "), transparencyReference);
          executeAction(cTID("setd"), transparencyDescriptor, DialogModes.NO);
          var rectangle = rectangles[index];
          document.selection.select([
            [rectangle.left, rectangle.top], [rectangle.right, rectangle.top],
            [rectangle.right, rectangle.bottom], [rectangle.left, rectangle.bottom]
          ], SelectionType.INTERSECT);
          var hasPixels = false;
          try { hasPixels = !!document.selection.bounds; } catch (emptyRegion) {}
          if (!hasPixels) continue;
          var descriptor = new ActionDescriptor();
          descriptor.putEnumerated(cTID("Usng"), cTID("FlCn"), sTID("contentAware"));
          descriptor.putUnitDouble(cTID("Opct"), cTID("#Prc"), 100);
          descriptor.putEnumerated(cTID("Md  "), cTID("BlnM"), cTID("Nrml"));
          executeAction(cTID("Fl  "), descriptor, DialogModes.NO);
        } catch (fillError) {
          warnings.push("部分角落字符未能修复，已保留回图：" + (fillError.message || fillError));
          break;
        }
      }
    } catch (error) {
      warnings.push("角落字符修复已跳过：" + (error.message || error));
    } finally {
      if (savedTransparencyLock !== null) {
        try { layer.transparentPixelsLocked = savedTransparencyLock; } catch (lockError) {}
      }
      if (selectionChanged) {
        try {
          if (savedChannel) document.selection.load(savedChannel);
          else document.selection.deselect();
        } catch (selectionError) { warnings.push("选区恢复失败：" + (selectionError.message || selectionError)); }
      }
      if (savedChannel) {
        try { savedChannel.remove(); } catch (removeError) {}
      }
      try { document.activeChannels = savedChannels; } catch (channelError) {}
    }
    return warnings;
  }

  AIGCSelectionRefiner._placeInternal = function () {
    var job = pendingPlacement;
    var savedChannel = null;
    var taskChannel = null;
    var savedChannels = null;
    var selectionChanged = false;
    var document = app.activeDocument;
    try {
      if (!job.selectionChannelName) throw new Error("原始选区快照缺失，请重新提交任务。");
      try { taskChannel = document.channels.getByName(job.selectionChannelName); }
      catch (missingSnapshot) { throw new Error("原始选区快照已被删除，请重新提交任务。"); }
      savedChannels = document.activeChannels;
      var hasSelection = false;
      try { hasSelection = !!document.selection.bounds; } catch (noSelection) {}
      if (hasSelection) {
        savedChannel = document.channels.add();
        document.selection.store(savedChannel);
      }
      document.activeChannels = document.componentChannels;
      selectionChanged = true;
      document.selection.deselect();
      placeFile(new File(job.resultPath));
      var layer = document.activeLayer;
      layer.name = selectionResultName(job.taskId);
      layer.rasterize(RasterizeType.ENTIRELAYER);

      var bounds = placedBounds(layer);
      if (!(bounds.width > 0 && bounds.height > 0)) throw new Error("返回图层尺寸无效。");
      var scale = Math.max(job.selection.width / bounds.width, job.selection.height / bounds.height);
      var fitted = { width: bounds.width * scale, height: bounds.height * scale };
      fitted.left = job.selection.left + (job.selection.width - fitted.width) / 2;
      fitted.top = job.selection.top + (job.selection.height - fitted.height) / 2;
      resizeAndMoveLayer(layer, fitted);
      var warnings = healResultRegions(layer, job.healRegions, fitted);
      if (Math.abs(fitted.width - job.selection.width) > 1 || Math.abs(fitted.height - job.selection.height) > 1) {
        warnings.push("返回比例不同，已等比覆盖并由原选区蒙版裁切，未拉伸。");
      }

      document.selection.load(taskChannel);
      makeRevealSelectionMask();
      var targetArtboard = findArtboard(document, job.artboard);
      if (targetArtboard) layer.move(targetArtboard, ElementPlacement.INSIDE);
      job.result = { placed: true, warnings: warnings };
    } catch (error) {
      job.error = error;
    } finally {
      if (selectionChanged) {
        try {
          if (savedChannel) document.selection.load(savedChannel);
          else document.selection.deselect();
        } catch (selectionError) {}
      }
      if (savedChannel) {
        try { savedChannel.remove(); } catch (removeError) {}
      }
      if (taskChannel && job.result && job.result.placed) {
        try { taskChannel.remove(); } catch (taskRemoveError) {}
      }
      if (savedChannels) {
        try { document.activeChannels = savedChannels; } catch (channelError) {}
      }
    }
  };

  AIGCSelectionRefiner.placeResult = function (resultPath, selection, selectionChannelName, documentId, healRegions, source, artboard, taskId) {
    var previousDialogMode = app.displayDialogs;
    var previousDocument = null;
    try {
      previousDocument = activateDocument(documentId);
      if (taskId && findNamedLayer(app.activeDocument, selectionResultName(taskId))) {
        restoreDocument(previousDocument);
        return ok({ placed: true, alreadyPlaced: true, warnings: [] });
      }
      validateSourceDimensions(source);
      app.displayDialogs = DialogModes.NO;
      useAcceleratedPlayback();
      pendingPlacement = {
        resultPath: resultPath,
        selection: selection,
        selectionChannelName: selectionChannelName,
        healRegions: healRegions || [],
        artboard: artboard || null,
        taskId: taskId || ""
      };
      withPixelUnits(function () {
        app.activeDocument.suspendHistory("AIGC 回填", "AIGCSelectionRefiner._placeInternal()");
      });
      var job = pendingPlacement;
      pendingPlacement = null;
      app.displayDialogs = previousDialogMode;
      if (job.error) throw job.error;
      restoreDocument(previousDocument);
      return ok(job.result || { placed: true });
    } catch (error) {
      pendingPlacement = null;
      try {
        app.displayDialogs = previousDialogMode;
      } catch (dialogError) {}
      restoreDocument(previousDocument);
      return fail(error);
    }
  };

  AIGCSelectionRefiner.openDocument = function (documentPath) {
    try {
      app.open(new File(documentPath));
      return ok({ opened: true, documentPath: documentPath });
    } catch (error) {
      return fail(error);
    }
  };

  var pendingLayers = null;

  function findGroup(document, name) {
    var index;
    for (index = 0; index < document.layerSets.length; index += 1) {
      if (document.layerSets[index].name === name) return document.layerSets[index];
    }
    return null;
  }

  function findGroupLayer(group, name) {
    var index;
    for (index = 0; index < group.layers.length; index += 1) {
      if (group.layers[index].name === name) return group.layers[index];
    }
    return null;
  }

  function moveOrderedLayer(layer, info, group, order) {
    var position = -1;
    var index;
    for (index = 0; index < order.length; index += 1) {
      if (order[index] === info.name) position = index;
    }
    var neighbor = null;
    for (index = position - 1; index >= 0; index -= 1) {
      neighbor = findGroupLayer(group, order[index]);
      if (neighbor) {
        layer.move(neighbor, ElementPlacement.PLACEBEFORE);
        return;
      }
    }
    for (index = position + 1; position >= 0 && index < order.length; index += 1) {
      neighbor = findGroupLayer(group, order[index]);
      if (neighbor) {
        layer.move(neighbor, ElementPlacement.PLACEAFTER);
        return;
      }
    }
    if (position < 0 && info.belowName) neighbor = findGroupLayer(group, info.belowName);
    if (neighbor) layer.move(neighbor, ElementPlacement.PLACEBEFORE);
    else if (group.layers.length) layer.move(group.layers[group.layers.length - 1], ElementPlacement.PLACEAFTER);
    else layer.move(group, ElementPlacement.INSIDE);
  }

  AIGCSelectionRefiner._placeLayersInternal = function () {
    var job = pendingLayers;
    var document = app.activeDocument;
    var canvas = documentBounds(document);
    var group = findGroup(document, job.groupName);
    var createdGroup = false;
    var index;
    for (index = 0; index < job.layers.length; index += 1) {
      var info = job.layers[index];
      if (!info || !info.path) continue;
      var layer = null;
      try {
        if (group && findGroupLayer(group, info.name)) {
          job.placed.push(info.name);
          continue;
        }
        placeFile(new File(info.path));
        layer = document.activeLayer;
        layer.name = info.name || ("AI 图层 " + (index + 1));
        var target = placementTarget(info, canvas);
        resizeAndMoveLayer(layer, target);
        var warnings = healResultRegions(layer, info.healRegions, target);
        var warningIndex;
        for (warningIndex = 0; warningIndex < warnings.length; warningIndex += 1) {
          job.warnings.push(layer.name + "：" + warnings[warningIndex]);
        }
        if (!group) {
          document.activeLayer = layer;
          group = document.layerSets.add();
          group.name = job.groupName;
          createdGroup = true;
        }
        moveOrderedLayer(layer, info, group, job.layerOrder);
        job.placed.push(info.name);
      } catch (layerError) {
        if (layer) {
          try { layer.remove(); } catch (removeError) {
            job.warnings.push((info.name || "失败图层") + "：残留图层未能移除，请先手动删除该层再重试。");
          }
        }
        job.failures.push((info.name || ("图层 " + (index + 1))) + "：" + (layerError.message || layerError));
      }
    }
    if (createdGroup && group && !group.layers.length) {
      try { group.remove(); } catch (emptyGroupError) {}
    }
  };

  AIGCSelectionRefiner.placeLayeredResult = function (layers, documentId, groupName, source, layerOrder) {
    var previousDialogMode = app.displayDialogs;
    var previousDocument = null;
    try {
      if (!layers || !layers.length) {
        throw new Error("没有可放入 Photoshop 的图层。");
      }
      previousDocument = activateDocument(documentId);
      validateSourceDimensions(source);
      app.displayDialogs = DialogModes.NO;
      useAcceleratedPlayback();
      pendingLayers = { layers: layers, layerOrder: layerOrder || [], placed: [], failures: [], warnings: [], groupName: groupName || "AI 分层" };
      withPixelUnits(function () {
        app.activeDocument.suspendHistory("AIGC 分层", "AIGCSelectionRefiner._placeLayersInternal()");
      });
      var job = pendingLayers;
      pendingLayers = null;
      app.displayDialogs = previousDialogMode;
      restoreDocument(previousDocument);
      return ok({ placed: job.placed, failures: job.failures, warnings: job.warnings });
    } catch (error) {
      pendingLayers = null;
      try {
        app.displayDialogs = previousDialogMode;
      } catch (dialogError) {}
      restoreDocument(previousDocument);
      return fail(error);
    }
  };
  AIGCSelectionRefiner.discardSelection = function (selectionChannelName, documentId) {
    var previousDocument = null;
    try {
      if (!app.documents.length || !selectionChannelName) {
        return ok({ removed: false });
      }
      previousDocument = activateDocument(documentId);
      try {
        app.activeDocument.channels.getByName(selectionChannelName).remove();
        return ok({ removed: true });
      } catch (channelError) {
        return ok({ removed: false });
      }
    } catch (error) {
      return fail(error);
    } finally {
      restoreDocument(previousDocument);
    }
  };
}());
