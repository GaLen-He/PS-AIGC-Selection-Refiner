function readUnitValue(value) {
  if (typeof value === "number") {
    return value;
  }

  if (value && typeof value._value === "number") {
    return value._value;
  }

  if (value && typeof value.value === "number") {
    return value.value;
  }

  throw new Error("Invalid Photoshop bounds value");
}

function normalizeBounds(bounds) {
  if (!bounds) {
    throw new Error("No active selection. Please select an area in Photoshop first.");
  }

  const left = Math.round(readUnitValue(bounds.left));
  const top = Math.round(readUnitValue(bounds.top));
  const right = Math.round(readUnitValue(bounds.right));
  const bottom = Math.round(readUnitValue(bounds.bottom));
  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0) {
    throw new Error("No active selection. Please select an area in Photoshop first.");
  }

  return { left, top, right, bottom, width, height };
}

function calculateTranslation(layerBounds, targetBounds) {
  return {
    x: targetBounds.left - layerBounds.left,
    y: targetBounds.top - layerBounds.top
  };
}

module.exports = {
  calculateTranslation,
  normalizeBounds
};
