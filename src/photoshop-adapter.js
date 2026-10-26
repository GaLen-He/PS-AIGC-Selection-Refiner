const photoshop = require("photoshop");
const uxp = require("uxp");

const { action, app, core } = photoshop;
const { localFileSystem, formats } = uxp.storage;
const { calculateTranslation, normalizeBounds } = require("./geometry");

async function runModal(commandName, callback) {
  return core.executeAsModal(callback, { commandName });
}

async function getSelectionBounds() {
  const [descriptor] = await action.batchPlay([
    {
      _obj: "get",
      _target: [
        { _property: "selection" },
        { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
      ],
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});

  return normalizeBounds(descriptor.selection || descriptor);
}

async function saveSelectionChannel(channelName) {
  await action.batchPlay([
    {
      _obj: "duplicate",
      _target: [{ _ref: "channel", _property: "selection" }],
      name: channelName,
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function restoreSelectionChannel(channelName, fallbackBounds) {
  try {
    await action.batchPlay([
      {
        _obj: "set",
        _target: [{ _property: "selection" }],
        to: { _ref: "channel", _name: channelName },
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {});
  } catch (_) {
    await selectRectangle(fallbackBounds);
  }
}

async function deleteSelectionChannel(channelName) {
  try {
    await action.batchPlay([
      {
        _obj: "delete",
        _target: [{ _ref: "channel", _name: channelName }],
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {});
  } catch (_) {
  }
}

async function selectRectangle(bounds) {
  await action.batchPlay([
    {
      _obj: "set",
      _target: [{ _property: "selection" }],
      to: {
        _obj: "rectangle",
        top: { _unit: "pixelsUnit", _value: bounds.top },
        left: { _unit: "pixelsUnit", _value: bounds.left },
        bottom: { _unit: "pixelsUnit", _value: bounds.bottom },
        right: { _unit: "pixelsUnit", _value: bounds.right }
      },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function copyMergedSelectionToNewDocument() {
  await action.batchPlay([
    {
      _obj: "copyEvent",
      merged: true,
      _options: { dialogOptions: "dontDisplay" }
    },
    {
      _obj: "make",
      _target: [{ _ref: "document" }],
      using: { _obj: "document", preset: "clipboard" },
      _options: { dialogOptions: "dontDisplay" }
    },
    {
      _obj: "paste",
      antiAlias: { _enum: "antiAliasType", _value: "antiAliasNone" },
      as: { _class: "pixel" },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function closeActiveDocumentWithoutSaving() {
  await action.batchPlay([
    {
      _obj: "close",
      saving: { _enum: "yesNo", _value: "no" },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function selectDocumentById(documentId) {
  await action.batchPlay([
    {
      _obj: "select",
      _target: [{ _ref: "document", _id: documentId }],
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function saveActiveDocumentAsPng(file) {
  await app.activeDocument.saveAs.png(file, { compression: 6 }, true);
}

async function readFileBase64(file) {
  const buffer = await file.read({ format: formats.binary });
  return arrayBufferToBase64(buffer);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64.replace(/^data:[^,]+,/, ""));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

async function exportSelectionAssets() {
  return runModal("Export AIGC selection", async () => {
    const sourceDocumentId = app.activeDocument.id;
    const selection = await getSelectionBounds();
    const channelName = `AIGC Selection ${Date.now()}`;
    const tempFolder = await localFileSystem.getTemporaryFolder();
    const cropFile = await tempFolder.createFile(`aigc-selection-${Date.now()}.png`, { overwrite: true });

    await saveSelectionChannel(channelName);
    await copyMergedSelectionToNewDocument();
    await saveActiveDocumentAsPng(cropFile);
    await closeActiveDocumentWithoutSaving();
    await selectDocumentById(sourceDocumentId);

    const imageBase64 = await readFileBase64(cropFile);

    return {
      selection,
      selectionChannelName: channelName,
      imageBase64,
      maskBase64: imageBase64
    };
  });
}

async function writeResultFile(result) {
  const tempFolder = await localFileSystem.getTemporaryFolder();
  const file = await tempFolder.createFile(`aigc-result-${Date.now()}.png`, { overwrite: true });

  if (result.type === "base64") {
    await file.write(base64ToArrayBuffer(result.base64), { format: formats.binary });
    return file;
  }

  const response = await fetch(result.url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status}).`);
  }

  await file.write(await response.arrayBuffer(), { format: formats.binary });
  return file;
}

async function placeFile(file) {
  await action.batchPlay([
    {
      _obj: "placeEvent",
      null: { _path: file.nativePath, _kind: "local" },
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      offset: {
        _obj: "offset",
        horizontal: { _unit: "pixelsUnit", _value: 0 },
        vertical: { _unit: "pixelsUnit", _value: 0 }
      },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function getActiveLayerBounds() {
  const [descriptor] = await action.batchPlay([
    {
      _obj: "get",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});

  return normalizeBounds(descriptor.bounds);
}

async function resizeActiveLayerToBounds(layerBounds, targetBounds) {
  const widthPercent = (targetBounds.width / layerBounds.width) * 100;
  const heightPercent = (targetBounds.height / layerBounds.height) * 100;

  await action.batchPlay([
    {
      _obj: "transform",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      width: { _unit: "percentUnit", _value: widthPercent },
      height: { _unit: "percentUnit", _value: heightPercent },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function moveActiveLayerBy(offset) {
  await action.batchPlay([
    {
      _obj: "move",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      to: {
        _obj: "offset",
        horizontal: { _unit: "pixelsUnit", _value: offset.x },
        vertical: { _unit: "pixelsUnit", _value: offset.y }
      },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function renameActiveLayer(name) {
  await action.batchPlay([
    {
      _obj: "set",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "layer", name },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function createRevealSelectionMask() {
  await action.batchPlay([
    {
      _obj: "make",
      at: { _ref: "channel", _enum: "channel", _value: "mask" },
      using: { _enum: "userMaskEnabled", _value: "revealSelection" },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {});
}

async function insertGenerationResult({ result, selection, selectionChannelName }) {
  const file = await writeResultFile(result);

  await runModal("Place AIGC result", async () => {
    await placeFile(file);
    await renameActiveLayer(`AIGC result ${new Date().toLocaleTimeString()}`);

    let layerBounds = await getActiveLayerBounds();
    if (layerBounds.width !== selection.width || layerBounds.height !== selection.height) {
      await resizeActiveLayerToBounds(layerBounds, selection);
      layerBounds = await getActiveLayerBounds();
    }

    await moveActiveLayerBy(calculateTranslation(layerBounds, selection));
    await restoreSelectionChannel(selectionChannelName, selection);
    await createRevealSelectionMask();
    await deleteSelectionChannel(selectionChannelName);
  });
}

module.exports = {
  exportSelectionAssets,
  insertGenerationResult
};
