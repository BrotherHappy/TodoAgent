#!/usr/bin/env node

/**
 * Recover the authored key-pose strip from an interpolated, vertically paged
 * atlas. This is useful when increasing interpolation density without asking
 * an image model to redraw the character: every 64th cell is an original key
 * pose in the v21/v19 sheets.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const [inputPath, outputPath, sourceColumnsArg = "10", sourceRowsArg = "4", stepsArg = "63"] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("Usage: extract-pet-atlas-keys.mjs <input.png> <output.png> [sourceColumns] [sourceRows] [steps]");
  process.exit(1);
}
const sourceColumns = Number.parseInt(sourceColumnsArg, 10);
const sourceRows = Number.parseInt(sourceRowsArg, 10);
const steps = Number.parseInt(stepsArg, 10);
if (![sourceColumns, sourceRows, steps].every(Number.isInteger) || sourceColumns < 1 || sourceRows < 1 || steps < 1) {
  throw new Error("sourceColumns, sourceRows and steps must be positive integers");
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
if (width % 16 !== 0 || height % (width / 16) !== 0) throw new Error("Input is not a 16-column 128px atlas");

const pageColumns = 16;
const cellWidth = width / pageColumns;
const pageRows = 4;
const cellHeight = cellWidth;
const stride = width * 4;
const inflated = zlib.inflateSync(Buffer.concat(idat));
const pixels = Buffer.alloc(width * height * 4);
let readOffset = 0;
let previous = Buffer.alloc(stride);
const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb ? (pa <= pc ? a : c) : (pb <= pc ? b : c);
};
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

const outputWidth = sourceColumns * cellWidth;
const outputHeight = sourceRows * cellHeight;
const output = Buffer.alloc(outputWidth * outputHeight * 4);
for (let sourceColumn = 0; sourceColumn < sourceColumns; sourceColumn += 1) {
  const generatedColumn = sourceColumn * (steps + 1);
  const page = Math.floor(generatedColumn / pageColumns);
  const localColumn = generatedColumn % pageColumns;
  for (let row = 0; row < sourceRows; row += 1) {
    const sourceRow = page * pageRows + row;
    for (let y = 0; y < cellHeight; y += 1) {
      const sourceOffset = ((sourceRow * cellHeight + y) * width + localColumn * cellWidth) * 4;
      const targetOffset = ((row * cellHeight + y) * outputWidth + sourceColumn * cellWidth) * 4;
      pixels.copy(output, targetOffset, sourceOffset, sourceOffset + cellWidth * 4);
    }
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let crc = n;
  for (let k = 0; k < 8; k += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[n] = crc >>> 0;
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
fs.writeFileSync(outputPath, Buffer.concat([
  signature,
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]));
console.log(`extracted ${inputPath} -> ${outputPath} (${sourceColumns}x${sourceRows} key poses)`);
