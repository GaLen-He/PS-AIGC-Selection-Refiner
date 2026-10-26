function createReservation(photoshop, sessionId, readAsset) {
  function findLayer(container, identity) {
    for (var layer of Array.from(container.layers || [])) {
      if (layer.id === identity) return layer;
      var nested = findLayer(layer, identity);
      if (nested) return nested;
    }
    return null;
  }

  function validate(args) {
    if (args.deadline && Date.now() >= args.deadline) throw Error('预建图层请求已超时。');
    if (!args.source || args.source.backgroundSessionId !== sessionId) throw Error('提交期间助手会话已变化，请重新提交。');
    var document = photoshop.app.activeDocument;
    if (!document || document.id !== args.documentId) throw Error('请在提交任务的当前文档中提交；不会切换窗口预建图层。');
    if (Number(document.width) !== args.source.width || Number(document.height) !== args.source.height) throw Error('原文档尺寸已变化，请重新提交。');
    if (!args.reservationId || !Array.isArray(args.names) || !args.names.length || args.names.length > 32 ||
      args.names.some(function (name) { return typeof name !== 'string' || !name.trim(); }) || new Set(args.names).size !== args.names.length) {
      throw Error('预建图层的名称或任务标识无效。');
    }
    if (args.names.length > 1 && !args.groupName) throw Error('分层预建需要独立结果组。');
    var artboard = args.artboard && findLayer(document, args.artboard.id);
    if (args.artboard && (!artboard || !artboard.layers)) throw Error('提交任务的画板已被删除。');
    return { document: document, artboard: artboard };
  }

  return async function (args) {
    validate(args);
    var maskBytes = null;
    if (args.mask) {
      var target = args.target;
      if (args.names.length !== 1 || !target || ![target.left, target.top, target.width, target.height].every(Number.isInteger) ||
        target.width <= 0 || target.height <= 0 || target.width * target.height > 100000000) throw Error('原选区蒙版范围无效。');
      maskBytes = await readAsset(args.mask, 0, target.width * target.height);
      if (!maskBytes || maskBytes.length !== target.width * target.height) throw Error('原选区蒙版不完整。');
    }
    return photoshop.core.executeAsModal(async function (execution) {
      var current = validate(args);
      var document = current.document;
      var selected = Array.from(document.activeLayers);
      async function restoreSelection() {
        if (!selected.length) {
          await photoshop.action.batchPlay([{ _obj: 'selectNoLayers',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], _options: { dialogOptions: 'dontDisplay' } }], {});
          return;
        }
        await photoshop.action.batchPlay([{ _obj: 'select', _target: selected.map(function (layer) { return { _ref: 'layer', _id: layer.id }; }),
          selectionModifier: { _enum: 'selectionModifierType', _value: '0' },
          makeVisible: false, _options: { dialogOptions: 'dontDisplay' } }], {});
      }
      var history = await execution.hostControl.suspendHistory({ documentID: document.id, name: 'AIGC 预建结果图层' });
      try {
        var group = args.groupName ? await document.createLayerGroup({ name: args.groupName }) : null;
        if (group && current.artboard) await group.move(current.artboard, photoshop.constants.ElementPlacement.PLACEINSIDE);
        var parent = group || current.artboard || document;
        var slots = [];
        var previous = null;
        for (var name of args.names) {
          var layer = await document.createPixelLayer({ name: name });
          if (parent !== document) await layer.move(parent, photoshop.constants.ElementPlacement.PLACEINSIDE);
          if (previous) await layer.move(previous, photoshop.constants.ElementPlacement.PLACEAFTER);
          slots.push({ layerId: layer.id, parentId: parent.id, groupId: group ? group.id : null,
            name: name, reservationId: args.reservationId, maskPrepared: !!maskBytes });
          previous = layer;
        }
        if (maskBytes) {
          var mask = await photoshop.imaging.createImageDataFromBuffer(maskBytes, {
            width: args.target.width, height: args.target.height, components: 1, colorSpace: 'Grayscale', colorProfile: 'Gray Gamma 2.2'
          });
          try {
            await photoshop.imaging.putLayerMask({ documentID: document.id, layerID: slots[0].layerId,
              imageData: mask, replace: true, targetBounds: { left: args.target.left, top: args.target.top } });
          } finally { mask.dispose(); }
        }
        if (group && Array.from(group.layers).map(function (layer) { return layer.id; }).join(',') !== slots.map(function (slot) { return slot.layerId; }).join(',')) {
          throw Error('预建图层排序不正确，已撤销。');
        }
        await restoreSelection();
        await execution.hostControl.resumeHistory(history, true);
        return { slots: slots, groupId: group ? group.id : null };
      } catch (error) {
        await execution.hostControl.resumeHistory(history, false);
        await restoreSelection();
        throw error;
      }
    }, { commandName: 'AIGC 预建结果图层', interactive: true });
  };
}

module.exports = { createReservation: createReservation };
