#!/usr/bin/env node

/**
 * Pack a loosely spaced image-model sprite strip into a deterministic atlas.
 *
 * The image model is good at drawing a coherent sequence, but it does not
 * always honour a requested column grid.  This packer uses the measured
 * centre of every frame, crops between neighbouring centres (leaving a small
 * safety gap), then aligns the lower body and baseline before writing a
 * regular square-cell PNG.  No frame is blended with its neighbour.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const [inputPath, outputPath, centersJson, rowsArg = "4", cellArg = "256", rowWindowsJson = ""] = process.argv.slice(2);
if (!inputPath || !outputPath || !centersJson) {
  console.error("Usage: pack-pet-atlas.mjs <input.png> <output.png> <centers-json> [rows] [cellSize] [row-windows-json]");
  process.exit(1);
}

const rows = Number.parseInt(rowsArg, 10);
const targetCell = Number.parseInt(cellArg, 10);
const centersByRow = JSON.parse(centersJson);
if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(targetCell) || targetCell < 1) {
  throw new Error("rows and cellSize must be positive integers");
}
if (!Array.isArray(centersByRow) || centersByRow.length !== rows) {
  throw new Error(`Expected one frame-centre array for each of ${rows} rows`);
}

const source = fs.readFileSync(inputPath);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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
  } else if (type === "IDAT") {
    idat.push(data);
  }
  offset += length + 12;
}
if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
  throw new Error(`Only non-interlaced 8-bit RGB/RGBA PNGs are supported (depth=${bitDepth}, type=${colorType}, interlace=${interlace})`);
}

const channels = colorType === 6 ? 4 : 3;
const bytesPerPixel = channels;
const stride = width * channels;
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
    const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
    const up = previous[x] ?? 0;
    const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
    if (filter === 1) row[x] = (row[x] + left) & 255;
    else if (filter === 2) row[x] = (row[x] + up) & 255;
    else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
    else if (filter === 4) row[x] = (row[x] + paeth(left, up, upperLeft)) & 255;
    else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
  }
  for (let x = 0; x < width; x += 1) {
    const sourceOffset = x * channels;
    const targetOffset = (y * width + x) * 4;
    pixels[targetOffset] = row[sourceOffset];
    pixels[targetOffset + 1] = row[sourceOffset + 1];
    pixels[targetOffset + 2] = row[sourceOffset + 2];
    pixels[targetOffset + 3] = channels === 4 ? row[sourceOffset + 3] : 255;
  }
  previous = row;
}

const rowHeight = height / rows;
const outputColumns = Math.max(...centersByRow.map((centers) => centers.length));
const outputWidth = outputColumns * targetCell;
const outputHeight = rows * targetCell;
const output = Buffer.alloc(outputWidth * outputHeight * 4);
const rowWindows = rowWindowsJson
  ? JSON.parse(rowWindowsJson)
  : Array.from({ length: rows }, (_, row) => ({ center: (row + 0.5) * rowHeight, height: rowHeight }));
if (!Array.isArray(rowWindows) || rowWindows.length !== rows) {
  throw new Error(`Expected one vertical crop window for each of ${rows} rows`);
}

function sample(x, y) {
  const safeX = Math.max(0, Math.min(width - 1, x));
  const safeY = Math.max(0, Math.min(height - 1, y));
  const index = (safeY * width + safeX) * 4;
  const alpha = pixels[index + 3] / 255;
  return [pixels[index] * alpha, pixels[index + 1] * alpha, pixels[index + 2] * alpha, alpha];
}

for (let row = 0; row < rows; row += 1) {
  const centers = centersByRow[row].map(Number);
  if (centers.length === 0 || centers.some((value) => !Number.isFinite(value))) {
    throw new Error(`Row ${row} has no valid frame centres`);
  }
  const spacings = centers.slice(1).map((center, index) => center - centers[index]);
  const sortedSpacings = [...spacings].sort((a, b) => a - b);
  const medianSpacing = sortedSpacings.length
    ? sortedSpacings[Math.floor(sortedSpacings.length / 2)]
    : width / centers.length;
  for (let column = 0; column < centers.length; column += 1) {
    const center = centers[column];
    const leftBoundary = column === 0
      ? center - medianSpacing / 2
      : (centers[column - 1] + center) / 2;
    const rightBoundary = column === centers.length - 1
      ? center + medianSpacing / 2
      : (center + centers[column + 1]) / 2;
    // Leave a small gap between crops.  It prevents a neighbouring tail or
    // effect mark from becoming a one-pixel strip at the next frame edge.
    const cropWidth = Math.max(1, (rightBoundary - leftBoundary) * 0.96);
    const cropX = center - cropWidth / 2;
    const verticalWindow = rowWindows[row];
    const cropHeight = Math.max(1, Number(verticalWindow.height));
    const cropY = Number(verticalWindow.center) - cropHeight / 2;
    const sourceScaleX = cropWidth / targetCell;
    const sourceScaleY = cropHeight / targetCell;
    const frame = Buffer.alloc(targetCell * targetCell * 4);
    let minX = targetCell;
    let maxX = -1;
    let minY = targetCell;
    let maxY = -1;
    let weightedX = 0;
    let weightedCount = 0;
    for (let y = 0; y < targetCell; y += 1) {
      const sourceY = cropY + (y + 0.5) * sourceScaleY - 0.5;
      const y0 = Math.floor(sourceY);
      const fy = sourceY - y0;
      for (let x = 0; x < targetCell; x += 1) {
        const sourceX = cropX + (x + 0.5) * sourceScaleX - 0.5;
        const x0 = Math.floor(sourceX);
        const fx = sourceX - x0;
        const a = sample(x0, y0);
        const b = sample(x0 + 1, y0);
        const c = sample(x0, y0 + 1);
        const d = sample(x0 + 1, y0 + 1);
        const top = a.map((value, index) => value * (1 - fx) + b[index] * fx);
        const bottom = c.map((value, index) => value * (1 - fx) + d[index] * fx);
        const alpha = top[3] * (1 - fy) + bottom[3] * fy;
        const index = (y * targetCell + x) * 4;
        frame[index + 3] = Math.round(alpha * 255);
        if (alpha > 0.08) {
          frame[index] = Math.round((top[0] * (1 - fy) + bottom[0] * fy) / alpha);
          frame[index + 1] = Math.round((top[1] * (1 - fy) + bottom[1] * fy) / alpha);
          frame[index + 2] = Math.round((top[2] * (1 - fy) + bottom[2] * fy) / alpha);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          // The lower half is mostly the body/feet and is a stable horizontal
          // anchor even when a hand, rope or sparkle moves independently.
          if (y > targetCell * 0.42) {
            weightedX += x;
            weightedCount += 1;
          }
        }
      }
    }
    if (maxX < 0) continue;
    const anchorX = weightedCount ? weightedX / weightedCount : (minX + maxX) / 2;
    const dx = Math.max(-22, Math.min(22, targetCell / 2 - anchorX));
    const desiredBottom = Math.round(targetCell * 0.93);
    const dy = Math.max(-18, Math.min(18, desiredBottom - maxY));
    const originX = column * targetCell;
    const originY = row * targetCell;
    for (let y = 0; y < targetCell; y += 1) {
      for (let x = 0; x < targetCell; x += 1) {
        const sourceIndex = (y * targetCell + x) * 4;
        const alpha = frame[sourceIndex + 3] / 255;
        if (alpha <= 0.0001) continue;
        const targetX = Math.round(x + dx);
        const targetY = Math.round(y + dy);
        if (targetX < 0 || targetY < 0 || targetX >= targetCell || targetY >= targetCell) continue;
        const targetIndex = ((originY + targetY) * outputWidth + originX + targetX) * 4;
        output[targetIndex] = frame[sourceIndex];
        output[targetIndex + 1] = frame[sourceIndex + 1];
        output[targetIndex + 2] = frame[sourceIndex + 2];
        output[targetIndex + 3] = frame[sourceIndex + 3];
      }
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
console.log(`packed ${inputPath} -> ${outputPath} (${outputWidth}x${outputHeight}, ${centersByRow.map((centers) => centers.length).join("/")} frames)`);
