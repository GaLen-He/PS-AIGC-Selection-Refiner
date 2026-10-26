(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AIGCResultCleanup = api;
}(this, function () {
  function luminance(data, offset) {
    return (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114) * data[offset + 3] / 255;
  }

  function cornerRun(data, width, height, box) {
    var boxWidth = box.right - box.left;
    var boxHeight = box.bottom - box.top;
    var candidates = new Uint8Array(boxWidth * boxHeight);
    var radius = Math.max(2, Math.round(height * 0.005));
    var minimumHeight = Math.max(5, Math.round(height * 0.011));
    var maximumHeight = Math.max(16, Math.round(height * 0.065));
    var row;
    var column;
    for (row = 0; row < boxHeight; row += 1) {
      for (column = 0; column < boxWidth; column += 1) {
        var imageX = box.left + column;
        var imageY = box.top + row;
        var offset = (imageY * width + imageX) * 4;
        var maximum = Math.max(data[offset], data[offset + 1], data[offset + 2]);
        var minimum = Math.min(data[offset], data[offset + 1], data[offset + 2]);
        if (data[offset + 3] < 24 || maximum - minimum > 90 || (minimum < 90 && maximum - minimum > 35)) continue;
        var samples = [];
        var deltaY;
        var deltaX;
        for (deltaY = -radius; deltaY <= radius; deltaY += radius) {
          for (deltaX = -radius; deltaX <= radius; deltaX += radius) {
            if (!deltaX && !deltaY) continue;
            var sampleX = Math.max(0, Math.min(width - 1, imageX + deltaX));
            var sampleY = Math.max(0, Math.min(height - 1, imageY + deltaY));
            samples.push(luminance(data, (sampleY * width + sampleX) * 4));
          }
        }
        samples.sort(function (first, second) { return first - second; });
        var contrast = luminance(data, offset) - (samples[3] + samples[4]) / 2;
        if (contrast >= 8) candidates[row * boxWidth + column] = 1;
        else if (contrast <= -8) candidates[row * boxWidth + column] = 2;
      }
    }
    var components = [];
    var fragments = [];
    var queue = new Int32Array(candidates.length);
    var start;
    for (start = 0; start < candidates.length; start += 1) {
      if (!candidates[start]) continue;
      var head = 0;
      var tail = 1;
      queue[0] = start;
      var polarity = candidates[start];
      candidates[start] = 0;
      var component = { left: boxWidth, top: boxHeight, right: 0, bottom: 0, count: 0, polarity: polarity };
      while (head < tail) {
        var current = queue[head++];
        var currentX = current % boxWidth;
        var currentY = Math.floor(current / boxWidth);
        component.left = Math.min(component.left, currentX);
        component.top = Math.min(component.top, currentY);
        component.right = Math.max(component.right, currentX + 1);
        component.bottom = Math.max(component.bottom, currentY + 1);
        component.count += 1;
        var neighborY;
        var neighborX;
        for (neighborY = Math.max(0, currentY - 1); neighborY <= Math.min(boxHeight - 1, currentY + 1); neighborY += 1) {
          for (neighborX = Math.max(0, currentX - 1); neighborX <= Math.min(boxWidth - 1, currentX + 1); neighborX += 1) {
            var neighbor = neighborY * boxWidth + neighborX;
            if (candidates[neighbor] === polarity) {
              candidates[neighbor] = 0;
              queue[tail++] = neighbor;
            }
          }
        }
      }
      var glyphHeight = component.bottom - component.top;
      var glyphWidth = component.right - component.left;
      var density = component.count / (glyphWidth * glyphHeight);
      if (glyphHeight >= 2 && glyphHeight <= maximumHeight && glyphWidth <= maximumHeight &&
        component.count >= 2 && density >= 0.08) {
        component.pixels = [];
        for (var pixelIndex = 0; pixelIndex < tail; pixelIndex += 1) {
          var local = queue[pixelIndex];
          component.pixels.push((box.top + Math.floor(local / boxWidth)) * width + box.left + local % boxWidth);
        }
        fragments.push(component);
      }
      if (glyphHeight >= minimumHeight && glyphHeight <= maximumHeight && glyphWidth <= maximumHeight &&
        component.count >= 5 && density >= 0.08 && density <= 0.86) components.push(component);
    }
    var best = null;
    components.forEach(function (anchor) {
      var anchorHeight = anchor.bottom - anchor.top;
      var glyphs = components.filter(function (component) {
        return component.polarity === anchor.polarity && Math.abs(component.bottom - anchor.bottom) <= anchorHeight * 0.4 &&
          Math.abs(component.top - anchor.top) <= anchorHeight * 0.55;
      }).sort(function (first, second) { return first.left - second.left; });
      var run = [];
      function finish() {
        if (run.length < 3 || run.length > 18) return;
        var left = run[0].left;
        var right = run[run.length - 1].right;
        var top = Math.min.apply(null, run.map(function (glyph) { return glyph.top; }));
        var bottom = Math.max.apply(null, run.map(function (glyph) { return glyph.bottom; }));
        if (right - left < (bottom - top) * 1.5 || right - left > width * 0.18) return;
        if (!best || run.length > best.glyphs) best = { left: left, top: top, right: right, bottom: bottom, glyphs: run.length, members: run.slice() };
      }
      glyphs.forEach(function (glyph) {
        if (run.length && glyph.left - run[run.length - 1].right > anchorHeight) {
          finish();
          run = [];
        }
        run.push(glyph);
      });
      finish();
    });
    if (!best) return null;
    var runHeight = best.bottom - best.top;
    var runLeft = best.left;
    var runRight = best.right;
    fragments.forEach(function (fragment) {
      if (fragment.top < best.top - runHeight * 0.1 || fragment.bottom > best.bottom + runHeight * 0.1) return;
      if (fragment.right <= runLeft && runLeft - fragment.right <= runHeight * 0.65) {
        best.left = Math.min(best.left, fragment.left);
        best.members.push(fragment);
      }
      if (fragment.left >= runRight && fragment.left - runRight <= runHeight * 0.65) {
        best.right = Math.max(best.right, fragment.right);
        best.members.push(fragment);
      }
    });
    var padding = Math.max(2, Math.round(height * 0.004));
    var horizontalPadding = Math.max(padding, Math.ceil(Math.min(runHeight, (runRight - runLeft) / best.glyphs)));
    var textPixels = [];
    best.members.forEach(function (member) { textPixels = textPixels.concat(member.pixels); });
    return {
      left: Math.max(0, box.left + best.left - horizontalPadding),
      top: Math.max(0, box.top + best.top - padding),
      right: Math.min(width, box.left + best.right + horizontalPadding),
      bottom: Math.min(height, box.top + best.bottom + padding),
      glyphs: best.glyphs,
      textPixels: textPixels
    };
  }

  function detectCornerText(data, width, height) {
    if (width < 200 || height < 160 || data.length !== width * height * 4) return [];
    var boxWidth = Math.ceil(width * 0.18);
    var boxHeight = Math.ceil(height * 0.09);
    var origins = [[0, 0], [width - boxWidth, 0], [0, height - boxHeight], [width - boxWidth, height - boxHeight]];
    var regions = origins.map(function (origin) {
      return cornerRun(data, width, height, { left: origin[0], top: origin[1], right: origin[0] + boxWidth, bottom: origin[1] + boxHeight });
    }).filter(function (region) { return !!region; });
    return regions.filter(function (region) {
      if (region.right - region.left > width * 0.2 || region.bottom - region.top > height * 0.15) return false;
      if (region.glyphs >= 5) return true;
      return regions.some(function (other) {
        if (region === other) return false;
        var ratio = (region.bottom - region.top) / (other.bottom - other.top);
        return ratio >= 0.65 && ratio <= 1.55;
      });
    });
  }

  function strokeMask(region, width, left, top, right, bottom) {
    var confirmed = {};
    (region.textPixels || []).forEach(function (pixel) {
      var centerX = pixel % width;
      var centerY = Math.floor(pixel / width);
      for (var neighborY = Math.max(top, centerY - 1); neighborY < Math.min(bottom, centerY + 2); neighborY += 1) {
        for (var neighborX = Math.max(left, centerX - 1); neighborX < Math.min(right, centerX + 2); neighborX += 1) {
          confirmed[neighborY * width + neighborX] = true;
        }
      }
    });
    return confirmed;
  }

  function repairStrokes(data, width, left, top, right, bottom, confirmed) {
    var boxWidth = right - left;
    var boxHeight = bottom - top;
    var pending = new Uint8Array(boxWidth * boxHeight);
    var remaining = 0;
    var repaired = 0;
    var row;
    var column;
    for (row = 0; row < boxHeight; row += 1) {
      for (column = 0; column < boxWidth; column += 1) {
        var pixel = (top + row) * width + left + column;
        if (confirmed[pixel] && data[pixel * 4 + 3] > 8) {
          pending[row * boxWidth + column] = 1;
          remaining += 1;
        }
      }
    }
    while (remaining) {
      var updates = [];
      for (row = 0; row < boxHeight; row += 1) {
        for (column = 0; column < boxWidth; column += 1) {
          var local = row * boxWidth + column;
          if (!pending[local]) continue;
          var total = [0, 0, 0];
          var count = 0;
          for (var neighborY = Math.max(0, row - 1); neighborY < Math.min(boxHeight, row + 2); neighborY += 1) {
            for (var neighborX = Math.max(0, column - 1); neighborX < Math.min(boxWidth, column + 2); neighborX += 1) {
              if (pending[neighborY * boxWidth + neighborX]) continue;
              var offset = ((top + neighborY) * width + left + neighborX) * 4;
              if (data[offset + 3] < 200) continue;
              for (var channel = 0; channel < 3; channel += 1) total[channel] += data[offset + channel];
              count += 1;
            }
          }
          if (count) updates.push({ local: local, values: total.map(function (value) { return value / count; }) });
        }
      }
      if (!updates.length) break;
      updates.forEach(function (update) {
        var offset = ((top + Math.floor(update.local / boxWidth)) * width + left + update.local % boxWidth) * 4;
        for (var channel = 0; channel < 3; channel += 1) data[offset + channel] = update.values[channel];
        pending[update.local] = 0;
      });
      remaining -= updates.length;
      repaired += updates.length;
    }
    return { repaired: repaired, remaining: remaining };
  }

  function prepareCleanup(data, width, height, regions, options) {
    var result = { deleted: 0, repaired: 0, repairIncomplete: 0, skipped: 0, healRegions: [] };
    (regions || []).forEach(function (region) {
      var left = Math.max(0, Math.floor(region.left));
      var top = Math.max(0, Math.floor(region.top));
      var right = Math.min(width, Math.ceil(region.right));
      var bottom = Math.min(height, Math.ceil(region.bottom));
      if (right <= left || bottom <= top) return;
      var confirmed = strokeMask(region, width, left, top, right, bottom);
      var occupiedBorder = 0;
      var coloredInside = 0;
      var opaqueInside = 0;
      var row;
      var column;
      for (row = top; row < bottom; row += 1) {
        for (column = left; column < right; column += 1) {
          var offset = (row * width + column) * 4;
          if (data[offset + 3] <= 8) continue;
          opaqueInside += 1;
          if (column < left + 2 || column >= right - 2 || row < top + 2 || row >= bottom - 2) occupiedBorder += 1;
          if (Math.max(data[offset], data[offset + 1], data[offset + 2]) - Math.min(data[offset], data[offset + 1], data[offset + 2]) > 100) coloredInside += 1;
        }
      }
      var area = (right - left) * (bottom - top);
      if (!occupiedBorder && coloredInside === 0 && opaqueInside < area * 0.65) {
        var unknown = false;
        for (row = top; row < bottom; row += 1) {
          for (column = left; column < right; column += 1) {
            if (data[(row * width + column) * 4 + 3] > 8 && !confirmed[row * width + column]) unknown = true;
          }
        }
        if (unknown) {
          result.skipped += 1;
          return;
        }
        for (row = top; row < bottom; row += 1) {
          for (column = left; column < right; column += 1) {
            if (confirmed[row * width + column]) data[(row * width + column) * 4 + 3] = 0;
          }
        }
        result.deleted += 1;
      } else {
        if (options && options.repair && region.textPixels && region.textPixels.length) {
          var repair = repairStrokes(data, width, left, top, right, bottom, confirmed);
          if (repair.repaired) result.repaired += 1;
          if (repair.remaining) result.repairIncomplete += 1;
        }
        result.healRegions.push({ left: left / width, top: top / height, right: right / width, bottom: bottom / height });
      }
    });
    return result;
  }

  return { detectCornerText: detectCornerText, prepareCleanup: prepareCleanup };
}));
