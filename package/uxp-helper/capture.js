function createCapture(photoshop) {
  function validate(args) {
    if (args.deadline && Date.now() >= args.deadline) throw Error('选区读取请求已超时。');
    var target = Array.from(photoshop.app.documents).find(function (document) { return document.id === args.documentId; });
    if (!target || !photoshop.app.activeDocument || photoshop.app.activeDocument.id !== target.id) throw Error('提交前活动文档已改变，请在目标文档重新提交。');
    var stamp = String(target.historyStates.length) + ':' + String(target.activeHistoryState.name);
    if (!args.source || Number(target.width) !== args.source.width || Number(target.height) !== args.source.height || stamp !== args.historyStamp) {
      throw Error('提交前文档或选区已改变，请重新点击提交。');
    }
    var bounds = args.selection;
    if (!bounds || ![bounds.left, bounds.top, bounds.width, bounds.height].every(function (value) { return Number.isFinite(value) && Math.floor(value) === value; }) ||
      bounds.width <= 0 || bounds.height <= 0 || bounds.width * bounds.height > 100000000) throw Error('原选区尺寸无效。');
    return target;
  }

  return function (args) {
    return photoshop.core.executeAsModal(async function (execution) {
      var target = validate(args);
      if (execution.isCancelled) throw Error('选区读取已取消。');
      var bounds = args.selection;
      var result = await photoshop.imaging.getSelection({ documentID: target.id,
        sourceBounds: { left: bounds.left, top: bounds.top, right: bounds.left + bounds.width, bottom: bounds.top + bounds.height } });
      try {
        var image = result.imageData;
        if (!image || image.components !== 1 || image.componentSize !== 8 || image.width !== bounds.width || image.height !== bounds.height ||
          !result.sourceBounds || result.sourceBounds.left !== bounds.left || result.sourceBounds.top !== bounds.top) throw Error('选区蒙版尺寸不匹配，已停止提交。');
        var data = await image.getData({ chunky: true });
        if (!data || data.length !== bounds.width * bounds.height) throw Error('选区蒙版数据不完整。');
        validate(args);
        if (execution.isCancelled) throw Error('选区读取已取消。');
        return { width: image.width, height: image.height, data: new Uint8Array(data) };
      } finally { if (result.imageData) result.imageData.dispose(); }
    }, { commandName: 'AIGC 读取原选区', interactive: true });
  };
}

module.exports = { createCapture: createCapture };
