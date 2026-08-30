#!/usr/bin/env node

/**
 * Add deterministic in-between frames to an already packed RGBA atlas.
 *
 * The source sheets are hand/generated poses. Signed-distance contour
 * interpolation is deliberately kept offline: the renderer only has to swap
 * one complete cell at a time, so it never exposes a partially painted frame.
 * Body and detached props use separate layers. The stable body interior is
 * colour-cross-faded at a shared coordinate; detached props (rope, sparkles
 * and floor shadow) use premultiplied raster blending so a thin effect cannot
 * disappear until the final cell or leave an SDF hole. A distance-field
 * envelope keeps the body silhouette single while one-sided alpha hand-offs
 * handle genuinely new/removed pixels.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const [inputPath, outputPath, columnsArg = "1", rowsArg = "1", stepsArg = "2"] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("Usage: interpolate-pet-atlas.mjs <input.png> <output.png> [columns] [rows] [steps]");
  process.exit(1);
}
const columns = Number.parseInt(columnsArg, 10);
const rows = Number.parseInt(rowsArg, 10);
const steps = Number.parseInt(stepsArg, 10);
if (![columns, rows, steps].every(Number.isInteger) || columns < 1 || rows < 1 || steps < 1) {
  throw new Error("columns, rows and steps must be positive integers");
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const source = fs.readFileSync(inputPath);
if (!source.subarray(0, 8).equals(signature)) throw new Error("Input is not a PNG");
let width = 0;
let height = 0;
let bitDepth = 0;
let colorType = 0;
let interlace = 0;
const idat = [];
let offset = 8;
while (offset < source.length) {
  const length = source.readUInt32BE(offset);
  const type = source.toString("ascii", offset + 4, offset + 8);
  const data = source.subarray(offset + 8, offset + 8 + length);
  if (type === "IHDR") {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
    interlace = data[12];
  } else if (type === "IDAT") idat.push(data);
  offset += length + 12;
}
if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
  throw new Error(`Only non-interlaced 8-bit RGBA PNGs are supported (depth=${bitDepth}, type=${colorType}, interlace=${interlace})`);
}
if (width % columns !== 0 || height % rows !== 0) {
  throw new Error(`PNG ${width}x${height} is not divisible by ${columns}x${rows}`);
}

const cellWidth = width / columns;
const cellHeight = height / rows;
const stride = width * 4;
const inflated = zlib.inflateSync(Buffer.concat(idat));
const pixels = Buffer.alloc(width * height * 4);
let readOffset = 0;
let previous = Buffer.alloc(stride);
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
for (let y = 0; y < height; y += 1) {
  const filter = inflated[readOffset++];
  const row = Buffer.from(inflated.subarray(readOffset, readOffset + stride));
  readOffset += stride;
  for (let x = 0; x < stride; x += 1) {
    const left = x >= 4 ? row[x - 4] : 0;
    const up = previous[x] ?? 0;
    const upperLeft = x >= 4 ? previous[x - 4] : 0;
    if (filter === 1) row[x] = (row[x] + left) & 255;
    else if (filter === 2) row[x] = (row[x] + up) & 255;
    else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
    else if (filter === 4) row[x] = (row[x] + paeth(left, up, upperLeft)) & 255;
    else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
  }
  row.copy(pixels, y * stride);
  previous = row;
}

const outputColumns = columns * (steps + 1) - steps;
const outputWidth = outputColumns * cellWidth;
const outputHeight = height;
const output = Buffer.alloc(outputWidth * outputHeight * 4);
const sourceCell = Buffer.alloc(cellWidth * cellHeight * 4);
const readCell = (column, row) => {
  for (let y = 0; y < cellHeight; y += 1) {
    const sourceOffset = ((row * cellHeight + y) * width + column * cellWidth) * 4;
    pixels.copy(sourceCell, y * cellWidth * 4, sourceOffset, sourceOffset + cellWidth * 4);
  }
  return Buffer.from(sourceCell);
};
const putCell = (cell, column, row) => {
  for (let y = 0; y < cellHeight; y += 1) {
    const targetOffset = ((row * cellHeight + y) * outputWidth + column * cellWidth) * 4;
    cell.copy(output, targetOffset, y * cellWidth * 4, (y + 1) * cellWidth * 4);
  }
};
/**
 * Two-pass chamfer distance transform.  A plain alpha cross-fade leaves two
 * ears/tails visible while a limb moves.  Interpolating signed distance fields
 * moves the silhouette boundary itself, then blends colour only inside that
 * moving boundary.  At runtime every result is still a complete RGBA cell.
 */
const distanceField = (cell, includeMask) => {
  const size = cellWidth * cellHeight;
  const inside = new Uint8Array(size);
  const toInside = new Float32Array(size);
  const toOutside = new Float32Array(size);
  const infinity = 1e4;
  for (let index = 0; index < size; index += 1) {
    const isInside = cell[index * 4 + 3] > 20 && (!includeMask || includeMask[index]);
    inside[index] = isInside ? 1 : 0;
    toInside[index] = isInside ? 0 : infinity;
    toOutside[index] = isInside ? infinity : 0;
  }
  const relax = (field) => {
    for (let y = 0; y < cellHeight; y += 1) {
      for (let x = 0; x < cellWidth; x += 1) {
        const index = y * cellWidth + x;
        let value = field[index];
        if (x > 0) value = Math.min(value, field[index - 1] + 1);
        if (y > 0) value = Math.min(value, field[index - cellWidth] + 1);
        if (x > 0 && y > 0) value = Math.min(value, field[index - cellWidth - 1] + 1.4142);
        if (x + 1 < cellWidth && y > 0) value = Math.min(value, field[index - cellWidth + 1] + 1.4142);
        field[index] = value;
      }
    }
    for (let y = cellHeight - 1; y >= 0; y -= 1) {
      for (let x = cellWidth - 1; x >= 0; x -= 1) {
        const index = y * cellWidth + x;
        let value = field[index];
        if (x + 1 < cellWidth) value = Math.min(value, field[index + 1] + 1);
        if (y + 1 < cellHeight) value = Math.min(value, field[index + cellWidth] + 1);
        if (x + 1 < cellWidth && y + 1 < cellHeight) value = Math.min(value, field[index + cellWidth + 1] + 1.4142);
        if (x > 0 && y + 1 < cellHeight) value = Math.min(value, field[index + cellWidth - 1] + 1.4142);
        field[index] = value;
      }
    }
  };
  relax(toInside);
  relax(toOutside);
  const signed = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    signed[index] = inside[index] ? toOutside[index] : -toInside[index];
  }
  return signed;
};
/**
 * Return the connected alpha components that belong to the pet itself.  The
 * atlas also contains thin, detached props (rope, sparkles and hands). Those
 * strokes should switch as a whole, while the body/ears/feet should use the
 * moving signed-distance contour. Starting from the stable centre of each
 * cell lets ears and feet follow the body without reintroducing prop ghosts.
 */
const bodyMask = (cell) => {
  const size = cellWidth * cellHeight;
  const visited = new Uint8Array(size);
  const mask = new Uint8Array(size);
  const queue = new Int32Array(size);
  const isOpaque = (index) => cell[index * 4 + 3] > 20;
  const isGroundShadow = (index) => {
    const y = Math.floor(index / cellWidth);
    if (y < cellHeight * 0.86) return false;
    const offset = index * 4;
    const alpha = cell[offset + 3] ?? 0;
    if (alpha <= 20) return false;
    const red = cell[offset] ?? 0;
    const green = cell[offset + 1] ?? 0;
    const blue = cell[offset + 2] ?? 0;
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    const luminance = (red + green + blue) / 3;
    // The authored floor shadow is a cool, near-neutral light stroke. Feet,
    // tail and the lower body remain saturated, so this conservative colour
    // test removes only the shadow even when it touches the body component.
    return luminance >= 150 && chroma <= 36;
  };
  const touchesBodyCore = (index) => {
    const x = index % cellWidth;
    const y = Math.floor(index / cellWidth);
    // The body core begins below the face/props. A hand entering from above
    // can overlap the old 20% threshold and would then be morphed as part of
    // the whole silhouette, making it pop at the midpoint. Starting in the
    // lower 38% keeps the torso/feet as the stable component while leaving
    // hands, rope arcs and sparkles in the detached-prop pass.
    return x >= cellWidth * 0.18
      && x <= cellWidth * 0.82
      && y >= cellHeight * 0.38;
  };
  for (let start = 0; start < size; start += 1) {
    if (visited[start] || !isOpaque(start)) continue;
    let head = 0;
    let tail = 0;
    let touches = false;
    const component = [];
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      component.push(index);
      if (touchesBodyCore(index)) touches = true;
      const x = index % cellWidth;
      const y = Math.floor(index / cellWidth);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= cellWidth || ny < 0 || ny >= cellHeight) continue;
          const next = ny * cellWidth + nx;
          if (!visited[next] && isOpaque(next)) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    if (touches) {
      for (const index of component) {
        if (!isGroundShadow(index)) mask[index] = 1;
      }
    }
  }
  return mask;
};
const maskAnchor = (cell, mask) => {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const x = pixel % cellWidth;
    const y = Math.floor(pixel / cellWidth);
    count += 1;
    sumX += x;
    sumY += y;
  }
  return count > 0
    ? { x: sumX / count, y: sumY / count }
    : { x: cellWidth / 2, y: cellHeight / 2 };
};
const sampleField = (field, x, y) => {
  if (x < 0 || y < 0 || x >= cellWidth - 1 || y >= cellHeight - 1) return -1e4;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const topLeft = field[y0 * cellWidth + x0];
  const topRight = field[y0 * cellWidth + x0 + 1];
  const bottomLeft = field[(y0 + 1) * cellWidth + x0];
  const bottomRight = field[(y0 + 1) * cellWidth + x0 + 1];
  return topLeft * (1 - tx) * (1 - ty)
    + topRight * tx * (1 - ty)
    + bottomLeft * (1 - tx) * ty
    + bottomRight * tx * ty;
};
/**
 * Bilinear RGBA sampling in premultiplied-alpha space.  Nearest-neighbour
 * sampling looks harmless at the source resolution, but a translated pose
 * crosses a half-pixel boundary every few interpolation steps and the whole
 * silhouette then jumps one pixel.  Keeping colour premultiplied while the
 * four neighbours are blended preserves a clean transparent edge; the result
 * is converted back to the straight-alpha representation used by the PNG
 * writer.  This is the key difference between a dense atlas that still reads
 * like a flipbook and one that has genuinely continuous motion.
 */
const samplePixel = (cell, x, y) => {
  const safeX = Math.max(0, Math.min(cellWidth - 1, x));
  const safeY = Math.max(0, Math.min(cellHeight - 1, y));
  const x0 = Math.floor(safeX);
  const y0 = Math.floor(safeY);
  const x1 = Math.min(cellWidth - 1, x0 + 1);
  const y1 = Math.min(cellHeight - 1, y0 + 1);
  const tx = safeX - x0;
  const ty = safeY - y0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  const accumulate = (px, py, weight) => {
    const offset = (py * cellWidth + px) * 4;
    const a = (cell[offset + 3] ?? 0) / 255;
    red += (cell[offset] ?? 0) * a * weight;
    green += (cell[offset + 1] ?? 0) * a * weight;
    blue += (cell[offset + 2] ?? 0) * a * weight;
    alpha += a * weight;
  };
  accumulate(x0, y0, (1 - tx) * (1 - ty));
  accumulate(x1, y0, tx * (1 - ty));
  accumulate(x0, y1, (1 - tx) * ty);
  accumulate(x1, y1, tx * ty);
  if (alpha <= 0.0001) return [0, 0, 0, 0];
  return [
    Math.round(red / alpha),
    Math.round(green / alpha),
    Math.round(blue / alpha),
    Math.round(alpha * 255),
  ];
};
const smoothstep = (edge0, edge1, value) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
/**
 * Keep one-sided pixels on the contour of the pose that owns them. A plain
 * SDF cross-fade averages an occupied field with the large negative field of
 * a transparent pose, so a detached prop (the floor shadow is the common
 * case) can stay invisible until the very last generated cell and then pop
 * in at t=1. When only one source contributes colour, use that source's
 * contour and let the premultiplied alpha do the temporal hand-off.
 */
const silhouetteFor = (sdfA, sdfB, pixelA, pixelB, t) => {
  const alphaA = pixelA[3] / 255;
  const alphaB = pixelB[3] / 255;
  const oneSidedField = alphaA <= 0.02 && alphaB > 0.02
    ? sdfB
    : alphaB <= 0.02 && alphaA > 0.02
      ? sdfA
      : sdfA * (1 - t) + sdfB * t;
  return smoothstep(-1.25, 1.25, oneSidedField);
};
const blend = (
  a,
  b,
  t,
  bodySdfA,
  bodySdfB,
  propSdfA,
  propSdfB,
  bodyMaskA,
  bodyMaskB,
  propMaskA,
  propMaskB,
  anchorA,
  anchorB,
  propAnchorA,
  propAnchorB,
  transformOnly,
) => {
  const result = Buffer.alloc(a.length);
  const deltaX = anchorB.x - anchorA.x;
  const deltaY = anchorB.y - anchorA.y;
  const propDeltaX = propAnchorB.x - propAnchorA.x;
  const propDeltaY = propAnchorB.y - propAnchorA.y;
  // When a key pose travels a long distance (for example the jump-rope hop),
  // a distance-field blend can have two valid zero contours at once. That is
  // mathematically correct but visually reads as a translucent duplicate pet.
  // Lock the whole pose to its body anchor for these segments and switch once
  // the two anchors meet; the silhouette remains single and the movement is a
  // clean translation instead of a torn double exposure. This deliberately
  // trades a single pose switch at the midpoint for a much safer visual result
  // than showing two semi-overlapping bodies during a hop.
  if (transformOnly) {
    // Large translations (the hop/rope beats) used to switch from the
    // translated A pose to the translated B pose at exactly t=.5. That kept
    // the silhouette single, but the midpoint cut was visible as a low-FPS
    // tear. Move each contour toward the shared midpoint and continuously
    // blend the two shifted rasters instead. The SDF envelope keeps one
    // connected silhouette while the premultiplied colour ramp gives the
    // prop and body pixels a real temporal hand-off.
    for (let index = 0, pixel = 0; index < a.length; index += 4, pixel += 1) {
      const x = pixel % cellWidth;
      const y = Math.floor(pixel / cellWidth);
      const isBodyCore = bodyMaskA[pixel] || bodyMaskB[pixel];
      const isProp = propMaskA[pixel] || propMaskB[pixel];
      if (!isBodyCore && !isProp) continue;
      const moveX = isBodyCore ? deltaX : propDeltaX;
      const moveY = isBodyCore ? deltaY : propDeltaY;
      const xShiftA = moveX * t;
      const yShiftA = moveY * t;
      const xShiftB = moveX * (t - 1);
      const yShiftB = moveY * (t - 1);
      const sdfA = isBodyCore
        ? sampleField(bodySdfA, x - xShiftA, y - yShiftA)
        : sampleField(propSdfA, x - xShiftA, y - yShiftA);
      const sdfB = isBodyCore
        ? sampleField(bodySdfB, x - xShiftB, y - yShiftB)
        : sampleField(propSdfB, x - xShiftB, y - yShiftB);
      const pixelA = samplePixel(a, x - xShiftA, y - yShiftA);
      const pixelB = samplePixel(b, x - xShiftB, y - yShiftB);
      const alphaA = pixelA[3] / 255;
      const alphaB = pixelB[3] / 255;
      // Detached effects (shadow, rope, sparkles) are intentionally treated
      // as raster layers here. Their fields can be disconnected between key
      // poses, and averaging those fields creates holes or a late pop. A
      // premultiplied alpha cross-fade keeps the entire prop visible while it
      // moves; only the body contour needs the SDF envelope.
      const propOnly = isProp && !isBodyCore;
      const silhouette = propOnly ? 1 : silhouetteFor(sdfA, sdfB, pixelA, pixelB, t);
      const weightA = alphaA * (1 - t);
      const weightB = alphaB * t;
      const weight = weightA + weightB;
      const outAlpha = Math.min(1, weight) * silhouette;
      result[index + 3] = Math.round(outAlpha * 255);
      if (weight <= 0.0001 || outAlpha <= 0.0001) continue;
      result[index] = Math.round((pixelA[0] * weightA + pixelB[0] * weightB) / weight);
      result[index + 1] = Math.round((pixelA[1] * weightA + pixelB[1] * weightB) / weight);
      result[index + 2] = Math.round((pixelA[2] * weightA + pixelB[2] * weightB) / weight);
    }
    return result;
  }
  for (let index = 0, pixel = 0; index < a.length; index += 4, pixel += 1) {
    const aAlpha = a[index + 3] / 255;
    const bAlpha = b[index + 3] / 255;
    if (Math.max(aAlpha, bAlpha) <= 0.0001) continue;
    const x = pixel % cellWidth;
    const y = Math.floor(pixel / cellWidth);
    // Keep the body and detached effects in separate contour fields. A rope
    // or sparkle must never pull the main silhouette into a second shape.
    const isBodyCore = bodyMaskA[pixel] || bodyMaskB[pixel];
    const isProp = propMaskA[pixel] || propMaskB[pixel];
    if (!isBodyCore && !isProp) continue;
    // Detached props (the hand, rope, sparkles and task card) get their own
    // anchor. Keeping their contour and colour samples in that moving frame
    // prevents the old behaviour where a rope/hand stayed fixed for half of
    // the transition and then snapped to the next pose at the midpoint.
    const moveX = isBodyCore ? deltaX : propDeltaX;
    const moveY = isBodyCore ? deltaY : propDeltaY;
    const xShift = moveX * t;
    const yShift = moveY * t;
    const xShiftB = moveX * (t - 1);
    const yShiftB = moveY * (t - 1);
    const sdfA = isBodyCore
      ? sampleField(bodySdfA, x - xShift, y - yShift)
      : sampleField(propSdfA, x - xShift, y - yShift);
    const sdfB = isBodyCore
      ? sampleField(bodySdfB, x - xShiftB, y - yShiftB)
      : sampleField(propSdfB, x - xShiftB, y - yShiftB);
    // A one-pixel feather keeps the interpolated contour antialiased while
    // preventing a transparent gap between consecutive poses. Body and each
    // detached prop use their own distance field, so a rope or sparkle cannot
    // pull the pet silhouette into a second ghost shape.
    // Props are sampled in their moving frame and blended as one premultiplied
    // layer. For the stable body core, however, keep both colours at the same
    // canvas coordinate and cross-fade them. A complete-pose winner makes an
    // entering hand appear in a single frame at t=.5; a shared-coordinate
    // blend gives that hand a real temporal ramp without drawing two
    // translated bodies on top of each other.
    const propBlend = isProp && !isBodyCore;
    const pixelA = propBlend
      ? samplePixel(a, x - xShift, y - yShift)
      : samplePixel(a, x, y);
    const pixelB = propBlend
      ? samplePixel(b, x - xShiftB, y - yShiftB)
      : samplePixel(b, x, y);
    const alphaA = pixelA[3] / 255;
    const alphaB = pixelB[3] / 255;
    const silhouette = propBlend ? 1 : silhouetteFor(sdfA, sdfB, pixelA, pixelB, t);
    const weightA = alphaA * (1 - t);
    const weightB = alphaB * t;
    // Body pixels that exist in only one key pose need an alpha hand-off (for
    // example the patting hand first touches the head). Pixels present in both
    // poses use a premultiplied colour blend at the shared coordinate. The
    // contour and alpha are still interpolated, so an entering hand can fade
    // in and a moving body can travel without exposing a translated duplicate.
    const oneSidedBody = !propBlend && (alphaA <= 0.02 || alphaB <= 0.02);
    const bodyBlendWeightA = alphaA * (1 - t);
    const bodyBlendWeightB = alphaB * t;
    const bodyBlendWeight = bodyBlendWeightA + bodyBlendWeightB;
    const sourceAlpha = propBlend
      ? Math.min(1, bodyBlendWeight)
      : oneSidedBody
        ? alphaA > alphaB ? alphaA * (1 - t) : alphaB * t
        : Math.min(1, bodyBlendWeight);
    const outAlpha = sourceAlpha * silhouette;
    result[index + 3] = Math.round(outAlpha * 255);
    if (outAlpha <= 0.0001) continue;
    if (propBlend && bodyBlendWeight > 0.0001) {
      result[index] = Math.round((pixelA[0] * bodyBlendWeightA + pixelB[0] * bodyBlendWeightB) / bodyBlendWeight);
      result[index + 1] = Math.round((pixelA[1] * bodyBlendWeightA + pixelB[1] * bodyBlendWeightB) / bodyBlendWeight);
      result[index + 2] = Math.round((pixelA[2] * bodyBlendWeightA + pixelB[2] * bodyBlendWeightB) / bodyBlendWeight);
    } else if (oneSidedBody && alphaA <= 0.02 && alphaB > 0.02) {
      result[index] = pixelB[0];
      result[index + 1] = pixelB[1];
      result[index + 2] = pixelB[2];
    } else if (oneSidedBody && alphaB <= 0.02 && alphaA > 0.02) {
      result[index] = pixelA[0];
      result[index + 1] = pixelA[1];
      result[index + 2] = pixelA[2];
    } else if (bodyBlendWeight > 0.0001) {
      const red = (pixelA[0] * bodyBlendWeightA + pixelB[0] * bodyBlendWeightB) / bodyBlendWeight;
      const green = (pixelA[1] * bodyBlendWeightA + pixelB[1] * bodyBlendWeightB) / bodyBlendWeight;
      const blue = (pixelA[2] * bodyBlendWeightA + pixelB[2] * bodyBlendWeightB) / bodyBlendWeight;
      result[index] = Math.round(red);
      result[index + 1] = Math.round(green);
      result[index + 2] = Math.round(blue);
    } else {
      result[index] = primary[0];
      result[index + 1] = primary[1];
      result[index + 2] = primary[2];
    }
  }
  return result;
};
for (let row = 0; row < rows; row += 1) {
  const cells = Array.from({ length: columns }, (_, column) => readCell(column, row));
  let outputColumn = 0;
  // Feed the rendered endpoint of one transition into the next transition.
  // The SDF edge intentionally has a small antialias envelope; if the next
  // segment started from the untouched source raster, the last generated
  // frame and the next key pose could still differ by an edge-sized jump.
  // Chaining the endpoint keeps the temporal path C0-continuous while
  // retaining the authored pose as the target of each segment.
  let fromCell = cells[0];
  putCell(fromCell, outputColumn++, row);
  for (let column = 0; column < columns - 1; column += 1) {
    const toCell = cells[column + 1];
    const bodyMaskA = bodyMask(fromCell);
    const bodyMaskB = bodyMask(toCell);
    const propMaskA = new Uint8Array(sourceCell.length / 4);
    const propMaskB = new Uint8Array(sourceCell.length / 4);
    for (let pixel = 0; pixel < propMaskA.length; pixel += 1) {
      if (fromCell[pixel * 4 + 3] > 20 && !bodyMaskA[pixel]) propMaskA[pixel] = 1;
      if (toCell[pixel * 4 + 3] > 20 && !bodyMaskB[pixel]) propMaskB[pixel] = 1;
    }
    const bodySdfA = distanceField(fromCell, bodyMaskA);
    const bodySdfB = distanceField(toCell, bodyMaskB);
    const propSdfA = distanceField(fromCell, propMaskA);
    const propSdfB = distanceField(toCell, propMaskB);
    const anchorA = maskAnchor(fromCell, bodyMaskA);
    const anchorB = maskAnchor(toCell, bodyMaskB);
    const propAnchorA = maskAnchor(fromCell, propMaskA);
    const propAnchorB = maskAnchor(toCell, propMaskB);
    let endpoint = fromCell;
    for (let step = 1; step <= steps; step += 1) {
      // Smoothstep avoids a linear “double exposure” peak at the centre.
      const linear = step / (steps + 1);
      const t = linear * linear * (3 - 2 * linear);
      putCell(
        blend(
          fromCell,
          toCell,
          t,
          bodySdfA,
          bodySdfB,
          propSdfA,
          propSdfB,
          bodyMaskA,
          bodyMaskB,
          propMaskA,
          propMaskB,
          anchorA,
          anchorB,
          propAnchorA,
          propAnchorB,
          // Extremely large body translations are kept as a clean single-pose
          // move. Ordinary hops and rope beats use the aligned SDF contour;
          // this avoids a midpoint shape switch while still protecting the
          // renderer from a genuine teleport in the source art.
          Math.hypot(anchorB.x - anchorA.x, anchorB.y - anchorA.y) > 44,
        ),
        outputColumn++,
        row,
      );
    }
    // Keep the authored endpoint byte-for-byte intact. At t=1 an SDF field
    // still has a feathered contour, and one-sided props can otherwise be
    // one compositor beat away from the source pose. The final in-between
    // now approaches this exact key pose with `silhouetteFor`, so the handoff
    // is continuous while the key itself is never rewritten.
    endpoint = Buffer.from(toCell);
    putCell(endpoint, outputColumn++, row);
    fromCell = endpoint;
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let crc = n;
  for (let k = 0; k < 8; k += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[n] = crc >>> 0;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return result;
}
const scanlines = Buffer.alloc((outputWidth * 4 + 1) * outputHeight);
for (let y = 0; y < outputHeight; y += 1) {
  const rowOffset = y * (outputWidth * 4 + 1);
  scanlines[rowOffset] = 0;
  output.copy(scanlines, rowOffset + 1, y * outputWidth * 4, (y + 1) * outputWidth * 4);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(outputWidth, 0);
header.writeUInt32BE(outputHeight, 4);
header[8] = 8;
header[9] = 6;
fs.writeFileSync(outputPath, Buffer.concat([
  signature,
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]));
console.log(`interpolated ${inputPath} -> ${outputPath} (${outputWidth}x${outputHeight}, ${outputColumns} frames/row, ${steps} in-betweens)`);
