var fs = require('fs');

function createReturn(options) {
  var bridge = options.bridge;
  var maskSize = options.maskSize || function (filePath) { return fs.statSync(filePath).size; };

  function blocked(message) {
    var error = Error(message);
    error.recoveryBlocked = true;
    error.phase = 'validate';
    return error;
  }

  function targetBounds(value) {
    var target = { left: Number(value && value.left || 0), top: Number(value && value.top || 0),
      width: Math.round(Number(value && value.width)), height: Math.round(Number(value && value.height)) };
    if (![target.left, target.top, target.width, target.height].every(function (number) { return Number.isFinite(number) && Math.floor(number) === number; }) ||
        target.width <= 0 || target.height <= 0 || target.width * target.height > 100000000) throw blocked('回贴范围无效或过大，结果已保留。');
    return target;
  }

  async function place(job, filePath, mode, maskPath, method) {
    var resources = [];
    try {
      await bridge.waitReady();
      var sessionId = bridge.sessionId();
      if (!sessionId || !job.source || job.source.backgroundSessionId !== sessionId) {
        throw blocked('原 Photoshop 助手会话已变化或任务身份缺失；PNG 已保留，不会按重用的文档 ID 回贴。');
      }
      if (!job.slot || !job.slot.layerId || !job.slot.reservationId) throw blocked('此任务没有提交时预建的目标图层，PNG 已保留；不会切换窗口补建。');
      var bytes = await options.renderPixels(filePath, job.target, mode);
      if (!Buffer.isBuffer(bytes) || bytes.length !== job.target.width * job.target.height * 4) throw Error('回贴图像像素长度不正确。');
      job.pixels = bridge.registerAsset(bytes);
      resources.push(job.pixels);
      job.mask = null;
      if (maskPath) {
        if (maskSize(maskPath) !== job.target.width * job.target.height) throw Error('原选区蒙版缓存不完整，结果已保留。');
        job.mask = bridge.registerAsset(maskPath);
        resources.push(job.mask);
      }
      return await bridge.request(method || 'place', job);
    } finally { resources.forEach(function (identity) { bridge.releaseAsset(identity); }); }
  }

  return {
    cleanup: async function (context, result, taskId, receipt, mode) {
      if (!receipt || !receipt.cleanupToken) return { cleaned: false, warnings: ['图片已贴回；未取得安全清理凭据，已跳过角落处理。'] };
      return place({ documentId: context.documentId, source: context.source, taskId: taskId,
        name: context.slot && context.slot.name,
        target: targetBounds(context.selection || context.target), artboard: context.artboard || null,
        slot: context.slot, cleanupToken: receipt.cleanupToken }, result.path, mode || 'cover', null, 'cleanup');
    },
    reserve: async function (context, names, groupName, reservationId) {
      var resource = null;
      try {
        await bridge.waitReady();
        if (!context.source || context.source.backgroundSessionId !== bridge.sessionId()) throw Error('提交期间助手会话已变化，请重新提交。');
        var target = context.selection ? targetBounds(context.selection) : null;
        if (context.selectionMaskPath) {
          if (!target || maskSize(context.selectionMaskPath) !== target.width * target.height) throw Error('原选区蒙版缓存不完整。');
          resource = bridge.registerAsset(context.selectionMaskPath);
        }
        return await bridge.request('reserve', { documentId: context.documentId, source: context.source,
          artboard: context.artboard || null, names: names, groupName: groupName, reservationId: reservationId, mask: resource, target: target });
      } finally { if (resource) bridge.releaseAsset(resource); }
    },
    selection: async function (context, result, taskId) {
      if (!context.slot || !context.slot.maskPrepared) throw blocked('此旧任务没有预建目标图层或原选区蒙版，PNG 已保留；不会切换窗口补建。');
      var target = targetBounds(context.selection);
      return place({ documentId: context.documentId, source: context.source, taskId: taskId,
        name: 'AIGC 平台返回结果', target: target, artboard: context.artboard || null, slot: context.slot }, result.path, 'cover', null);
    },
    layers: async function (items, context, groupName, layerOrder) {
      var result = { placed: [], failures: [], warnings: [], receipts: {} };
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        try {
          var placed = await place({ documentId: context.documentId, source: context.source, taskId: item.taskId,
            name: item.name, target: targetBounds(item.target || context.source), artboard: context.artboard || null,
            groupName: groupName, layerOrder: layerOrder, slot: item.slot }, item.path, 'contain', null);
          if (!placed || !placed.placed) throw Error('后台助手未确认图层写入。');
          result.placed.push(item.name);
          result.receipts[item.taskId] = { cleanupToken: placed.cleanupToken };
          result.warnings = result.warnings.concat(placed.warnings || []);
        } catch (error) {
          if (error.backgroundUnavailable || error.retryable || error.recoveryBlocked || error.phase) throw error;
          result.failures.push(item.name + '：' + error.message);
        }
      }
      return result;
    }
  };
}

module.exports = { createReturn: createReturn };
