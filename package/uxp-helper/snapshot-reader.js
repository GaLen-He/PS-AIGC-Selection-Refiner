function createReader(photoshop) {
  function validate(args, historyId) {
    if (args.deadline && Date.now() >= args.deadline) throw Error('图像读取请求已超时。');
    var document = Array.from(photoshop.app.documents).find(function (item) { return item.id === args.documentId; });
    if (!document) throw Error('提交任务的原文档已关闭，未提交生图。');
    var history = document.activeHistoryState;
    if (!args.source || Number(document.width) !== args.source.width || Number(document.height) !== args.source.height ||
      String(document.historyStates.length) + ':' + String(history.name) !== args.historyStamp ||
      (historyId !== undefined && history.id !== historyId)) {
      throw Error('原文档在取图前已变化，未提交生图。');
    }
    if (!(history.id > 0)) throw Error('无法锁定原图历史快照，未提交生图。');
    return document;
  }

  return async function (args) {
    var document = validate(args);
    var historyId = document.activeHistoryState.id;
    var target = args.selection || args.source;
    if (!target || ![target.left, target.top, target.width, target.height].every(Number.isInteger) ||
      target.width <= 0 || target.height <= 0) throw Error('图像读取范围无效。');
    var scale = Math.min(1, 2048 / Math.max(target.width, target.height));
    var startedAt = Date.now();
    var snapshot = await photoshop.core.executeAsModal(async function (execution) {
      if (execution.isCancelled) throw Error('图像读取已取消。');
      validate(args, historyId);
      var result = await photoshop.imaging.getPixels({ documentID: document.id, historyStateID: historyId,
        sourceBounds: { left: target.left, top: target.top, right: target.left + target.width, bottom: target.top + target.height },
        targetSize: { width: Math.max(1, Math.round(target.width * scale)), height: Math.max(1, Math.round(target.height * scale)) },
        colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1', componentSize: 8, applyAlpha: true });
      try {
        var image = result.imageData;
        if (!image || image.componentSize !== 8 || ![3, 4].includes(image.components) ||
          !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0 ||
          image.width > 2048 || image.height > 2048) throw Error('返回的选区像素尺寸无效。');
        var level = result.level === undefined ? 0 : result.level;
        if (!Number.isInteger(level) || level < 0 || level > 20) throw Error('返回的像素缓存级别无效。');
        var bounds = result.sourceBounds;
        if (!bounds || ![bounds.left, bounds.top].every(Number.isFinite)) throw Error('返回的像素边界缺失。');
        var factor = Math.pow(2, level);
        var width = bounds.width === undefined ? bounds.right - bounds.left : bounds.width;
        var height = bounds.height === undefined ? bounds.bottom - bounds.top : bounds.height;
        if (![width, height].every(Number.isFinite) || !(width > 0 && height > 0)) throw Error('返回的像素边界无效。');
        var bytes = await image.getData({ chunky: true });
        if (!bytes || bytes.length !== image.width * image.height * image.components) throw Error('选区像素数据不完整。');
        if (execution.isCancelled) throw Error('图像读取已取消。');
        if (args.deadline && Date.now() >= args.deadline) throw Error('图像读取请求已超时。');
        return { bytes: new Uint8Array(bytes), width: image.width, height: image.height, components: image.components,
          bounds: { left: bounds.left * factor, top: bounds.top * factor, width: width * factor, height: height * factor } };
      } finally { if (result.imageData) result.imageData.dispose(); }
    }, { commandName: 'AIGC 读取提交区域', interactive: true });
    var rgba = new Uint8Array(snapshot.width * snapshot.height * 4);
    for (var pixel = 0; pixel < snapshot.width * snapshot.height; pixel += 1) {
      var source = pixel * snapshot.components;
      var destination = pixel * 4;
      rgba[destination] = snapshot.bytes[source];
      rgba[destination + 1] = snapshot.bytes[source + 1];
      rgba[destination + 2] = snapshot.bytes[source + 2];
      rgba[destination + 3] = snapshot.components === 4 ? snapshot.bytes[source + 3] : 255;
      if (pixel > 0 && pixel % 262144 === 0) await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }
    if (args.deadline && Date.now() >= args.deadline) throw Error('图像读取请求已超时。');
    return { data: rgba, width: snapshot.width, height: snapshot.height, bounds: snapshot.bounds,
      timing: { readMs: Date.now() - startedAt } };
  };
}

module.exports = { createReader: createReader };
