#!/usr/bin/env node

/**
 * Re-pack a wide RGBA pet atlas into vertically stacked pages.
 *
 * WebKit/GPU texture limits are usually much smaller than a 109/145-cell
 * horizontal strip. A page keeps a bounded width (16 cells by default),
 * while stacking pages vertically preserves a single decoded image and the
 * exact source-rectangle renderer. The runtime therefore never asks the GPU
 * to sample a 28k/37k pixel texture, and frame changes remain atomic.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const [inputPath, outputPath, columnsArg = "1", rowsArg = "1", pageColumnsArg = "16"] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("Usage: page-pet-atlas.mjs <input.png> <output.png> <columns> <rows> [pageColumns]");
  process.exit(1);
}

const columns = Number.parseInt(columnsArg, 10);
const rows = Number.parseInt(rowsArg, 10);
const pageColumns = Number.parseInt(pageColumnsArg, 10);
if (![columns, rows, pageColumns].every(Number.isInteger) || columns < 1 || rows < 1 || pageColumns < 1) {
  throw new Error("columns, rows and pageColumns must be positive integers");
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
  } else if (type === "IDAT") {
    idat.push(data);
  }
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
const inputStride = width * 4;
const inflated = zlib.inflateSync(Buffer.concat(idat));
const pixels = Buffer.alloc(width * height * 4);
let readOffset = 0;
let previous = Buffer.alloc(inputStride);
const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
for (let y = 0; y < height; y += 1) {
  const filter = inflated[readOffset++];
  const row = Buffer.from(inflated.subarray(readOffset, readOffset + inputStride));
  readOffset += inputStride;
  for (let x = 0; x < inputStride; x += 1) {
    const left = x >= 4 ? row[x - 4] : 0;
    const up = previous[x] ?? 0;
    const upperLeft = x >= 4 ? previous[x - 4] : 0;
    if (filter === 1) row[x] = (row[x] + left) & 255;
    else if (filter === 2) row[x] = (row[x] + up) & 255;
    else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
    else if (filter === 4) row[x] = (row[x] + paeth(left, up, upperLeft)) & 255;
    else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
  }
  row.copy(pixels, y * inputStride);
  previous = row;
}

const pageCount = Math.ceil(columns / pageColumns);
const outputColumns = pageColumns;
const outputRows = rows * pageCount;
const outputWidth = outputColumns * cellWidth;
const outputHeight = outputRows * cellHeight;
const output = Buffer.alloc(outputWidth * outputHeight * 4);

// Each page occupies `rows` source rows. Empty cells in the final page stay
// transparent, so the renderer can keep one stable columns/rows grid.
for (let page = 0; page < pageCount; page += 1) {
  for (let row = 0; row < rows; row += 1) {
    for (let localColumn = 0; localColumn < pageColumns; localColumn += 1) {
      const sourceColumn = page * pageColumns + localColumn;
      if (sourceColumn >= columns) continue;
      for (let y = 0; y < cellHeight; y += 1) {
        const sourceOffset = ((row * cellHeight + y) * width + sourceColumn * cellWidth) * 4;
        const targetOffset = (((page * rows + row) * cellHeight + y) * outputWidth + localColumn * cellWidth) * 4;
        pixels.copy(output, targetOffset, sourceOffset, sourceOffset + cellWidth * 4);
      }
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
console.log(`paged ${inputPath} -> ${outputPath} (${outputWidth}x${outputHeight}, ${pageCount} pages, ${pageColumns} columns/page)`);
