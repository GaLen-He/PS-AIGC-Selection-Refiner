function createWriter(photoshop, readAsset, sessionId) {
  var tail = Promise.resolve();
  var completedLayers = new Map();
  var cleanupReceipts = new Map();

  function mutableError(value) {
    var error = Error(String(value && value.message || value));
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      Object.getOwnPropertyNames(value).forEach(function (key) {
        try { error[key] = value[key]; } catch (ignored) {}
      });
    }
    return error;
  }

  function isGroup(layer) {
    var kinds = photoshop.constants && photoshop.constants.LayerKind;
    if (kinds && layer.kind !== undefined) return layer.kind === kinds.GROUP;
    return !!layer.layers;
  }

  function findLayer(container, identity) {
    var layers = Array.from(container.layers || []);
    for (var index = 0; index < layers.length; index += 1) {
      var layer = layers[index];
      if (layer.id === identity) return { layer: layer, parent: container };
      var nested = isGroup(layer) ? findLayer(layer, identity) : null;
      if (nested) return nested;
    }
    return null;
  }

  function integer(value) {
    return Number.isFinite(value) && Math.floor(value) === value;
  }

  function validationFailure(message, blocked) {
    var error = Error(message);
    error.recoveryBlocked = blocked !== false;
    throw error;
  }

  function validate(job) {
    if (job.deadline && Date.now() >= job.deadline) validationFailure('后台请求已超时，结果仍保留。', false);
    if (sessionId && (!job.source || job.source.backgroundSessionId !== sessionId)) {
      validationFailure('原 Photoshop 助手会话已变化或任务身份缺失；结果已保留，不会按重用的文档 ID 回贴。');
    }
    var document = Array.from(photoshop.app.documents).find(function (item) { return item.id === job.documentId; });
    if (!document) validationFailure('提交任务的原文档已关闭，结果已保留，不会放到其他文件。');
    if (!job.source || Number(document.width) !== job.source.width || Number(document.height) !== job.source.height) {
      validationFailure('原文档尺寸已变化，已停止回贴以免错位。');
    }
    var target = job.target;
    if (!target || ![target.left, target.top, target.width, target.height].every(integer) ||
      target.width <= 0 || target.height <= 0 || target.width * target.height > 100000000) validationFailure('回贴像素范围无效或超出安全上限。');
    if (!job.taskId || !job.name || !job.pixels) validationFailure('回贴任务缺少标识或像素数据。');
    if (job.mask) validationFailure('后台回贴不能新建蒙版；原选区蒙版必须在提交时预建，PNG 已保留。');
    if (job.artboard) {
      var artboard = findLayer(document, job.artboard.id);
      if (!artboard || !isGroup(artboard.layer)) validationFailure('提交任务的画板已被删除，结果已保留。');
    }
    var slot = job.slot;
    if (!slot || !integer(slot.layerId) || !integer(slot.parentId) || !slot.name || !slot.reservationId) {
      validationFailure('此任务没有提交时预建的目标图层，PNG 已保留；不会切换窗口补建图层。');
    }
    var destination = findLayer(document, slot.layerId);
    if (!destination) validationFailure('提交时预建的目标图层已被删除，PNG 已保留；请检查原文档中的预建结果层。');
    if (destination.layer.name !== slot.name) validationFailure('提交时预建的目标图层已被改名，PNG 已保留；恢复原图层名称后可重试。');
    if (isGroup(destination.layer)) validationFailure('提交时预建的目标图层类型已变化，PNG 已保留；不会写入图层组。');
    var kinds = photoshop.constants && photoshop.constants.LayerKind;
    if (kinds && kinds.NORMAL !== undefined && destination.layer.kind !== undefined && destination.layer.kind !== kinds.NORMAL) {
      validationFailure('预建目标层不再是像素图层，结果已保留；请将原目标层恢复为像素图层后重试。');
    }
    if (destination.parent.id !== slot.parentId ||
      (slot.groupId && slot.groupId !== destination.parent.id) ||
      (!slot.groupId && job.artboard && destination.parent.id !== job.artboard.id)) {
      validationFailure('提交时预建的目标图层已被移动，PNG 已保留；放回原图层组后可重试。');
    }
    if (slot.groupId) {
      var group = findLayer(document, slot.groupId);
      if (!group || group.parent.id !== (job.artboard ? job.artboard.id : document.id)) {
        validationFailure('预建结果组已移出原画板或文档层级，PNG 已保留；不会重新移动图层。');
      }
    }
    if (destination.layer.locked || destination.layer.allLocked || destination.layer.pixelsLocked) {
      validationFailure('预建目标图层已锁定，结果已保留，请解锁后重试。', false);
    }
    if (destination.layer.transparentPixelsLocked) validationFailure('预建目标图层的透明像素已锁定，结果已保留；请取消透明像素锁定后重试。', false);
    return { document: document, layer: destination.layer };
  }

  async function prepareStripes(job) {
    var target = job.target;
    var rowsPerStripe = Math.max(1, Math.floor(4 * 1024 * 1024 / (target.width * 4)));
    var stripes = [];
    for (var row = 0; row < target.height; row += rowsPerStripe) {
      if (job.deadline && Date.now() >= job.deadline) throw Error('后台请求已超时，结果仍保留。');
      var rows = Math.min(rowsPerStripe, target.height - row);
      var bytes = await readAsset(job.pixels, row * target.width * 4, rows * target.width * 4);
      if (!bytes || bytes.length !== rows * target.width * 4) throw Error('回贴像素数据不完整。');
      var visible = false;
      var opaque = true;
      for (var alpha = 3; alpha < bytes.length; alpha += 4) {
        if (bytes[alpha]) visible = true;
        if (bytes[alpha] !== 255) opaque = false;
      }
      if (!visible) continue;
      var components = opaque ? 3 : 4;
      var pixels = bytes;
      if (opaque) {
        pixels = new Uint8Array(rows * target.width * 3);
        for (var source = 0, destination = 0; source < bytes.length; source += 4) {
          pixels[destination++] = bytes[source];
          pixels[destination++] = bytes[source + 1];
          pixels[destination++] = bytes[source + 2];
        }
      }
      stripes.push({ row: row, rows: rows, pixels: pixels, components: components });
    }
    if (!stripes.length) throw Error('返回图片完全透明，没有可见像素；原图层未修改，结果已保留。');
    return stripes;
  }

  function historyId(document) {
    try { return document.activeHistoryState.id; } catch (ignored) { return null; }
  }

  async function compatibilityPixels(job, stripes, originalMask) {
    var target = job.target;
    var baseMask = originalMask || new Uint8Array(target.width * target.height).fill(255);
    if (!originalMask && job.slot.maskPrepared) {
      await photoshop.core.executeAsModal(async function (execution) {
        validate(job);
        if (execution.isCancelled) throw Error('蒙版读取已取消，结果仍保留。');
        var activeId = photoshop.app.activeDocument && photoshop.app.activeDocument.id;
        var result = await photoshop.imaging.getLayerMask({ documentID: job.documentId, layerID: job.slot.layerId,
          sourceBounds: { left: target.left, top: target.top, right: target.left + target.width, bottom: target.top + target.height } });
        try {
          var image = result.imageData;
          var bounds = result.sourceBounds;
          if (!image || image.components !== 1 || !bounds || image.width !== bounds.right - bounds.left || image.height !== bounds.bottom - bounds.top) {
            throw Error('原选区蒙版像素边界无效；保留原结果，不会扩大选区。');
          }
          var mask = await image.getData({ chunky: true });
          if (mask.length !== image.width * image.height) throw Error('原选区蒙版像素不完整。');
          baseMask.fill(0);
          for (var row = 0; row < image.height; row += 1) {
            var destinationRow = bounds.top - target.top + row;
            if (destinationRow < 0 || destinationRow >= target.height) continue;
            for (var column = 0; column < image.width; column += 1) {
              var destinationColumn = bounds.left - target.left + column;
              if (destinationColumn >= 0 && destinationColumn < target.width) baseMask[destinationRow * target.width + destinationColumn] = mask[row * image.width + column];
            }
          }
        } finally { if (result.imageData) { try { result.imageData.dispose(); } catch (ignored) {} } }
        if ((photoshop.app.activeDocument && photoshop.app.activeDocument.id) !== activeId) throw Error('读取蒙版改变了活动文档，已停止兼容写入。');
      }, { commandName: 'AIGC 读取原选区蒙版', interactive: true });
    }
    var combined = new Uint8Array(baseMask.length);
    var compatible = stripes.map(function (stripe) {
      var count = target.width * stripe.rows;
      var rgb = stripe.components === 3 ? stripe.pixels : new Uint8Array(count * 3);
      for (var pixel = 0; pixel < count; pixel += 1) {
        var offset = stripe.row * target.width + pixel;
        var alpha = stripe.components === 4 ? stripe.pixels[pixel * 4 + 3] : 255;
        combined[offset] = Math.round(baseMask[offset] * alpha / 255);
        if (stripe.components === 4) rgb.set(stripe.pixels.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
      }
      return { row: stripe.row, rows: stripe.rows, pixels: rgb, components: 3 };
    });
    return { stripes: compatible, mask: combined, originalMask: baseMask };
  }

  async function placeNow(job, cleanupReceipt) {
    var context;
    try { context = validate(job); }
    catch (error) {
      error = mutableError(error);
      error.phase = 'validate';
      error.recoveryBlocked = error.recoveryBlocked === true;
      throw error;
    }
    var taskKey = JSON.stringify([job.documentId, job.slot.reservationId, job.slot.layerId]);
    var previousTask = completedLayers.get(taskKey);
    if (!cleanupReceipt && previousTask === job.taskId) return { placed: true, alreadyPlaced: true, layerId: context.layer.id, warnings: [] };
    if (!cleanupReceipt && previousTask) {
      var conflict = Error('该预建目标图层已接收另一个任务，结果已保留，不会覆盖。');
      conflict.recoveryBlocked = true;
      conflict.phase = 'validate';
      throw conflict;
    }
    var phase = 'preparePixels';
    var stripeIndex = null;
    var pixelInfo = null;
    var stripes = [];
    var warnings = [];
    var originalMask = cleanupReceipt && cleanupReceipt.originalMask;
    var originalPixelError = null;
    var committed = false;

    async function writePixels(writing, maskBytes) {
      phase = 'executeAsModal';
      return photoshop.core.executeAsModal(async function (execution) {
        if (cleanupReceipt && historyId(context.document) !== cleanupReceipt.historyId) return { cleaned: false, warnings: ['图片已贴回；文档已有后续编辑，跳过字符清理以免覆盖。'] };
        phase = 'validate';
        var current;
        try { current = validate(job); }
        catch (error) { error = mutableError(error); error.recoveryBlocked = error.recoveryBlocked === true; throw error; }
        var activeId = photoshop.app.activeDocument && photoshop.app.activeDocument.id;
        phase = 'suspendHistory';
        var history = await execution.hostControl.suspendHistory({ documentID: current.document.id,
          name: cleanupReceipt ? 'AIGC 回贴后字符清理' : job.groupName ? 'AIGC 分层' : 'AIGC 选区细化' });
        try {
          for (var index = 0; index < writing.length; index += 1) {
            if (job.deadline && Date.now() >= job.deadline) throw Error('后台请求已超时，结果仍保留。');
            if (execution.isCancelled) throw Error('回贴已取消，结果仍保留。');
            var stripe = writing[index];
            stripeIndex = index;
            pixelInfo = { width: job.target.width, height: stripe.rows, components: stripe.components,
              left: job.target.left, top: job.target.top + stripe.row, documentId: current.document.id,
              layerId: current.layer.id, layerKind: current.layer.kind === undefined ? null : current.layer.kind };
            phase = 'createImageData';
            var image = await photoshop.imaging.createImageDataFromBuffer(stripe.pixels, {
              width: job.target.width, height: stripe.rows, components: stripe.components, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1'
            });
            try {
              phase = 'putPixels';
              await photoshop.imaging.putPixels({ documentID: current.document.id, layerID: current.layer.id, imageData: image,
                replace: index === 0, targetBounds: { left: job.target.left, top: job.target.top + stripe.row } });
            } finally {
              try { image.dispose(); }
              catch (disposeError) {
                if (!warnings.length) warnings.push('[disposeImageData] 图像缓冲区立即释放失败，将由运行时回收；不影响已写入像素。');
              }
            }
            phase = 'verifyActiveDocument';
            if ((photoshop.app.activeDocument && photoshop.app.activeDocument.id) !== activeId) {
              var activation = Error('Photoshop 像素接口改变了活动文档，已回滚；不会切换回贴。');
              activation.recoveryBlocked = true;
              throw activation;
            }
          }
          if (maskBytes) {
            phase = 'putAlphaMask';
            var maskImage = await photoshop.imaging.createImageDataFromBuffer(maskBytes, { width: job.target.width,
              height: job.target.height, components: 1, colorSpace: 'Grayscale', colorProfile: 'Gray Gamma 2.2' });
            try {
              await photoshop.imaging.putLayerMask({ documentID: current.document.id, layerID: current.layer.id,
                imageData: maskImage, replace: true, targetBounds: { left: job.target.left, top: job.target.top } });
            } finally { try { maskImage.dispose(); } catch (ignored) {} }
            if ((photoshop.app.activeDocument && photoshop.app.activeDocument.id) !== activeId) throw Error('蒙版接口改变了活动文档，已回滚。');
          }
          phase = 'resumeHistory';
          await execution.hostControl.resumeHistory(history, true);
          committed = true;
          return { placed: true, layerId: current.layer.id, warnings: warnings };
        } catch (error) {
          error = mutableError(error);
          error.phase = phase;
          try { await execution.hostControl.resumeHistory(history, false); }
          catch (rollbackError) { error.rollbackError = String(rollbackError.message || rollbackError); }
          throw error;
        }
      }, { commandName: cleanupReceipt ? 'AIGC 回贴后字符清理' : 'AIGC 后台写入结果', interactive: true });
    }
    try {
      stripes = await prepareStripes(job);
      var result;
      if (originalMask) {
        var existingCompatibility = await compatibilityPixels(job, stripes, originalMask);
        result = await writePixels(existingCompatibility.stripes, existingCompatibility.mask);
      } else if (stripes.some(function (stripe) { return stripe.components === 4; })) {
        phase = 'prepareAlphaMask';
        var alphaPixels = await compatibilityPixels(job, stripes, null);
        originalMask = alphaPixels.originalMask;
        result = await writePixels(alphaPixels.stripes, alphaPixels.mask);
      } else {
        try { result = await writePixels(stripes, null); }
        catch (error) {
          if (error.phase !== 'putPixels' || error.rollbackError || !pixelInfo || pixelInfo.components !== 4 ||
            !(error.number === -1 || error.code === -1 || /Code:\s*-1/.test(String(error.message || error)))) throw error;
          originalPixelError = mutableError(error);
          originalPixelError.pixelInfo = pixelInfo;
          originalPixelError.stripe = stripeIndex;
          phase = 'prepareAlphaCompatibility';
          var compatible = await compatibilityPixels(job, stripes, null);
          originalMask = compatible.originalMask;
          result = await writePixels(compatible.stripes, compatible.mask);
        }
      }
      if (!committed) return result;
      if (cleanupReceipt) return { cleaned: true, warnings: warnings };
      completedLayers.set(taskKey, job.taskId);
      var stamp = historyId(context.document);
      if (stamp !== null && stamp !== undefined) {
        var token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        cleanupReceipts.set(token, { taskKey: taskKey, taskId: job.taskId, historyId: stamp, originalMask: originalMask,
          target: JSON.stringify(job.target), expires: Date.now() + 120000 });
        result.cleanupToken = token;
      }
      var retainedMaskBytes = 0;
      cleanupReceipts.forEach(function (receipt, token) {
        if (receipt.expires < Date.now()) cleanupReceipts.delete(token);
        else retainedMaskBytes += receipt.originalMask ? receipt.originalMask.byteLength : 0;
      });
      while (cleanupReceipts.size > 20 || retainedMaskBytes > 67108864) {
        var oldestToken = cleanupReceipts.keys().next().value;
        var oldest = cleanupReceipts.get(oldestToken);
        retainedMaskBytes -= oldest.originalMask ? oldest.originalMask.byteLength : 0;
        cleanupReceipts.delete(oldestToken);
      }
      return result;
    } catch (error) {
      error = mutableError(error);
      if (originalPixelError) {
        originalPixelError.compatibilityError = String(error.message || error);
        originalPixelError.compatibilityPhase = error.phase || phase;
        if (error.rollbackError) originalPixelError.rollbackError = error.rollbackError;
        throw originalPixelError;
      }
      error.phase = error.phase || phase;
      error.stripe = stripeIndex;
      if (pixelInfo) error.pixelInfo = pixelInfo;
      throw error;
    } finally { stripes.length = 0; }
  }

  return {
    place: function (job) {
      var result = tail.then(function () { return placeNow(job); });
      tail = result.catch(function () {});
      return result;
    },
    cleanup: function (job) {
      var result = tail.then(function () {
        var receipt = cleanupReceipts.get(job.cleanupToken);
        var taskKey = JSON.stringify([job.documentId, job.slot && job.slot.reservationId, job.slot && job.slot.layerId]);
        if (!receipt || receipt.expires < Date.now() || receipt.taskKey !== taskKey || receipt.taskId !== job.taskId ||
          receipt.target !== JSON.stringify(job.target)) return { cleaned: false, warnings: ['图片已贴回；字符清理凭据已失效，跳过清理。'] };
        cleanupReceipts.delete(job.cleanupToken);
        var context = validate(job);
        if (historyId(context.document) !== receipt.historyId) return { cleaned: false, warnings: ['图片已贴回；文档已有后续编辑，跳过字符清理以免覆盖。'] };
        return placeNow(job, receipt);
      });
      tail = result.catch(function () {});
      return result;
    }
  };
}

module.exports = { createWriter: createWriter };
