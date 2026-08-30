#!/usr/bin/env node

/**
 * Add deterministic in-between frames to an already packed RGBA atlas.
 *
 * The source sheets are hand/generated poses. Signed-distance contour
 * interpolation is deliberately kept offline: the renderer only has to swap
 * one complete cell at a time, so it never exposes a partially painted frame.
 * Body and detached props use their own moving contour fields, then share a
 * premultiplied colour blend. That removes the old midpoint colour cut which
 * caused a one-frame tear in hands, ropes and sparkles.
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
  const touchesBodyCore = (index) => {
    const x = index % cellWidth;
    const y = Math.floor(index / cellWidth);
    return x >= cellWidth * 0.18
      && x <= cellWidth * 0.82
      && y >= cellHeight * 0.2;
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
      for (const index of component) mask[index] = 1;
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
const samplePixel = (cell, x, y) => {
  const px = Math.max(0, Math.min(cellWidth - 1, Math.round(x)));
  const py = Math.max(0, Math.min(cellHeight - 1, Math.round(y)));
  const offset = (py * cellWidth + px) * 4;
  return [cell[offset], cell[offset + 1], cell[offset + 2], cell[offset + 3]];
};
const smoothstep = (edge0, edge1, value) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
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
  const primaryIsA = t < 0.5;
  const pose = primaryIsA ? a : b;
  // When a key pose travels a long distance (for example the jump-rope hop),
  // a distance-field blend can have two valid zero contours at once. That is
  // mathematically correct but visually reads as a translucent duplicate pet.
  // Lock the whole pose to its body anchor for these segments and switch once
  // the two anchors meet; the silhouette remains single and the movement is a
  // clean translation instead of a torn double exposure. This deliberately
  // trades a single pose switch at the midpoint for a much safer visual result
  // than showing two semi-overlapping bodies during a hop.
  if (transformOnly) {
    const xShift = deltaX * (primaryIsA ? t : t - 1);
    const yShift = deltaY * (primaryIsA ? t : t - 1);
    for (let index = 0, pixel = 0; index < a.length; index += 4, pixel += 1) {
      const x = pixel % cellWidth;
      const y = Math.floor(pixel / cellWidth);
      const sampled = samplePixel(pose, x - xShift, y - yShift);
      if (sampled[3] <= 0) continue;
      result[index] = sampled[0];
      result[index + 1] = sampled[1];
      result[index + 2] = sampled[2];
      result[index + 3] = sampled[3];
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
    const isBodyCore = bodyMaskA[pixel] || bodyMaskB[pixel]
      || (x >= cellWidth * 0.2 && x <= cellWidth * 0.8 && y >= cellHeight * 0.24);
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
    const silhouette = smoothstep(-1.25, 1.25, sdfA * (1 - t) + sdfB * t);
    // The old implementation switched all interior colours from A to B at
    // exactly t=0.5. That one-cell colour cut was the remaining source of the
    // visible "tear": the contour moved smoothly, but eyes, paws and props
    // jumped to the other pose in a single frame. Both samples are already
    // translated into the intermediate body/prop coordinate, so a
    // premultiplied colour blend is safe here and keeps the silhouette single.
    const pixelA = samplePixel(a, x - xShift, y - yShift);
    const pixelB = samplePixel(b, x - xShiftB, y - yShiftB);
    const alphaA = pixelA[3] / 255;
    const alphaB = pixelB[3] / 255;
    const weightA = alphaA * (1 - t);
    const weightB = alphaB * t;
    const sourceWeight = weightA + weightB;
    const sourceAlpha = Math.min(1, sourceWeight);
    const outAlpha = sourceAlpha * silhouette;
    result[index + 3] = Math.round(outAlpha * 255);
    if (outAlpha <= 0.0001) continue;
    result[index] = Math.round(
      (pixelA[0] * weightA + pixelB[0] * weightB) / sourceWeight,
    );
    result[index + 1] = Math.round(
      (pixelA[1] * weightA + pixelB[1] * weightB) / sourceWeight,
    );
    result[index + 2] = Math.round(
      (pixelA[2] * weightA + pixelB[2] * weightB) / sourceWeight,
    );
  }
  return result;
};
for (let row = 0; row < rows; row += 1) {
  const cells = Array.from({ length: columns }, (_, column) => readCell(column, row));
  let outputColumn = 0;
  for (let column = 0; column < columns; column += 1) {
    putCell(cells[column], outputColumn++, row);
    if (column === columns - 1) continue;
    const bodyMaskA = bodyMask(cells[column]);
    const bodyMaskB = bodyMask(cells[column + 1]);
    const propMaskA = new Uint8Array(sourceCell.length / 4);
    const propMaskB = new Uint8Array(sourceCell.length / 4);
    for (let pixel = 0; pixel < propMaskA.length; pixel += 1) {
      if (cells[column][pixel * 4 + 3] > 20 && !bodyMaskA[pixel]) propMaskA[pixel] = 1;
      if (cells[column + 1][pixel * 4 + 3] > 20 && !bodyMaskB[pixel]) propMaskB[pixel] = 1;
    }
    const bodySdfA = distanceField(cells[column], bodyMaskA);
    const bodySdfB = distanceField(cells[column + 1], bodyMaskB);
    const propSdfA = distanceField(cells[column], propMaskA);
    const propSdfB = distanceField(cells[column + 1], propMaskB);
    const anchorA = maskAnchor(cells[column], bodyMaskA);
    const anchorB = maskAnchor(cells[column + 1], bodyMaskB);
    const propAnchorA = maskAnchor(cells[column], propMaskA);
    const propAnchorB = maskAnchor(cells[column + 1], propMaskB);
    for (let step = 1; step <= steps; step += 1) {
      // Smoothstep avoids a linear “double exposure” peak at the centre.
      const linear = step / (steps + 1);
      const t = linear * linear * (3 - 2 * linear);
      putCell(
        blend(
          cells[column],
          cells[column + 1],
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
