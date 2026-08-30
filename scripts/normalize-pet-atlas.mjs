#!/usr/bin/env node

/**
 * Normalize an image-model sprite sheet for the renderer.
 *
 * Image models often return a light checkerboard instead of a real alpha
 * channel. This small, dependency-free utility removes only the border-
 * connected checkerboard pixels, then resamples every cell to a common square
 * size using premultiplied-alpha bilinear sampling. Keeping this in the repo
 * makes future atlas updates repeatable instead of relying on an editor.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const [inputPath, outputPath, columnsArg = "12", rowsArg = "4", cellArg = "256"] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("Usage: normalize-pet-atlas.mjs <input.png> <output.png> [columns] [rows] [cellSize]");
  process.exit(1);
}

const columns = Number.parseInt(columnsArg, 10);
const rows = Number.parseInt(rowsArg, 10);
const targetCell = Number.parseInt(cellArg, 10);
if (![columns, rows, targetCell].every(Number.isFinite) || columns < 1 || rows < 1 || targetCell < 1) {
  throw new Error("columns, rows and cellSize must be positive integers");
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

// Only pixels connected to the outer edge can be the model's checkerboard.
// This keeps enclosed cream/white details (eyes and belly) intact.
const background = new Uint8Array(width * height);
const queue = new Int32Array(width * height);
let queueStart = 0;
let queueEnd = 0;
const isChecker = (x, y) => {
  const i = (y * width + x) * 4;
  const r = pixels[i];
  const g = pixels[i + 1];
  const b = pixels[i + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return pixels[i + 3] > 0 && min >= 232 && max - min <= 14;
};
const enqueue = (x, y) => {
  const position = y * width + x;
  if (!background[position] && isChecker(x, y)) {
    background[position] = 1;
    queue[queueEnd++] = position;
  }
};
for (let x = 0; x < width; x += 1) {
  enqueue(x, 0);
  enqueue(x, height - 1);
}
for (let y = 1; y < height - 1; y += 1) {
  enqueue(0, y);
  enqueue(width - 1, y);
}
while (queueStart < queueEnd) {
  const position = queue[queueStart++];
  const x = position % width;
  const y = Math.floor(position / width);
  if (x > 0) enqueue(x - 1, y);
  if (x + 1 < width) enqueue(x + 1, y);
  if (y > 0) enqueue(x, y - 1);
  if (y + 1 < height) enqueue(x, y + 1);
}

// A rope, loop, or prop can enclose a checkerboard pocket that is not
// connected to the outer border. Remove only large neutral components so
// small cream highlights and eyes remain untouched.
const componentSeen = new Uint8Array(width * height);
const componentQueue = new Int32Array(width * height);
const largeComponentThreshold = Math.max(1500, Math.floor((width * height) / (columns * rows) * 0.045));
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const startPosition = y * width + x;
    if (componentSeen[startPosition] || !isChecker(x, y)) continue;
    let start = 0;
    let end = 0;
    let componentSize = 0;
    componentQueue[end++] = startPosition;
    componentSeen[startPosition] = 1;
    while (start < end) {
      const position = componentQueue[start++];
      componentSize += 1;
      const px = position % width;
      const py = Math.floor(position / width);
      const visit = (nx, ny) => {
        const nextPosition = ny * width + nx;
        if (!componentSeen[nextPosition] && isChecker(nx, ny)) {
          componentSeen[nextPosition] = 1;
          componentQueue[end++] = nextPosition;
        }
      };
      if (px > 0) visit(px - 1, py);
      if (px + 1 < width) visit(px + 1, py);
      if (py > 0) visit(px, py - 1);
      if (py + 1 < height) visit(px, py + 1);
    }
    if (componentSize >= largeComponentThreshold) {
      for (let i = 0; i < end; i += 1) {
        background[componentQueue[i]] = 1;
      }
    }
  }
}
for (let i = 0; i < background.length; i += 1) {
  if (background[i]) pixels[i * 4 + 3] = 0;
}

const outputWidth = columns * targetCell;
const outputHeight = rows * targetCell;
const output = Buffer.alloc(outputWidth * outputHeight * 4);
const sample = (x, y) => {
  const safeX = Math.max(0, Math.min(width - 1, x));
  const safeY = Math.max(0, Math.min(height - 1, y));
  const i = (safeY * width + safeX) * 4;
  const alpha = pixels[i + 3] / 255;
  return [pixels[i] * alpha, pixels[i + 1] * alpha, pixels[i + 2] * alpha, alpha];
};
for (let y = 0; y < outputHeight; y += 1) {
  const sourceY = (y + 0.5) * height / outputHeight - 0.5;
  const y0 = Math.floor(sourceY);
  const fy = sourceY - y0;
  for (let x = 0; x < outputWidth; x += 1) {
    const sourceX = (x + 0.5) * width / outputWidth - 0.5;
    const x0 = Math.floor(sourceX);
    const fx = sourceX - x0;
    const a = sample(x0, y0);
    const b = sample(x0 + 1, y0);
    const c = sample(x0, y0 + 1);
    const d = sample(x0 + 1, y0 + 1);
    const top = a.map((value, index) => value * (1 - fx) + b[index] * fx);
    const bottom = c.map((value, index) => value * (1 - fx) + d[index] * fx);
    const alpha = top[3] * (1 - fy) + bottom[3] * fy;
    const i = (y * outputWidth + x) * 4;
    output[i + 3] = Math.round(alpha * 255);
    if (alpha > 0.0001) {
      output[i] = Math.round((top[0] * (1 - fy) + bottom[0] * fy) / alpha);
      output[i + 1] = Math.round((top[1] * (1 - fy) + bottom[1] * fy) / alpha);
      output[i + 2] = Math.round((top[2] * (1 - fy) + bottom[2] * fy) / alpha);
    }
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const typeBuffer = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return result;
};
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
const encoded = Buffer.concat([
  signature,
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(outputPath, encoded);
console.log(`normalized ${inputPath} -> ${outputPath} (${outputWidth}x${outputHeight}, removed ${queueEnd} checkerboard pixels)`);
