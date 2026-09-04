#!/usr/bin/env node

/**
 * Split a vertically paged RGBA atlas into bounded GPU textures.
 *
 * WebKit reports a 16,384px MAX_TEXTURE_SIZE on many Macs. A single atlas
 * that is only 2,048px wide can still exceed that limit when it is 18k–25kpx
 * tall, which makes the compositor tile the texture internally and can show
 * a torn frame while the source rectangle changes. This utility keeps every
 * runtime page square (16×16 cells by default), so both dimensions stay well
 * below common GPU limits.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [inputPath, outputDirectory, prefix = "atlas", columnsArg = "16", pageRowsArg = "16"] = process.argv.slice(2);
if (!inputPath || !outputDirectory) {
  console.error("Usage: split-pet-atlas-pages.mjs <input.png> <output-directory> [prefix] [columns] [pageRows]");
  process.exit(1);
}
const columns = Number.parseInt(columnsArg, 10);
const pageRows = Number.parseInt(pageRowsArg, 10);
if (![columns, pageRows].every(Number.isInteger) || columns < 1 || pageRows < 1) {
  throw new Error("columns and pageRows must be positive integers");
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
if (width % columns !== 0) throw new Error(`PNG width ${width} is not divisible by ${columns}`);

const cellWidth = width / columns;
const rowCount = height / cellWidth;
if (!Number.isInteger(rowCount)) throw new Error(`PNG height ${height} is not divisible by cell size ${cellWidth}`);
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

const pageCount = Math.ceil(rowCount / pageRows);
fs.mkdirSync(outputDirectory, { recursive: true });
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
const writePng = (targetPath, pagePixels, pageHeight) => {
  const scanlines = Buffer.alloc((width * 4 + 1) * pageHeight);
  for (let y = 0; y < pageHeight; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    scanlines[rowOffset] = 0;
    pagePixels.copy(scanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(pageHeight, 4);
  header[8] = 8;
  header[9] = 6;
  fs.writeFileSync(targetPath, Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
};

for (let page = 0; page < pageCount; page += 1) {
  // Keep a stable cell geometry even for the final partial page. The unused
  // rows remain transparent, and the renderer can use one constant page size
  // without a one-frame scale jump at the end of a loop.
  const pageHeight = pageRows * cellWidth;
  const pagePixels = Buffer.alloc(width * pageHeight * 4);
  const sourceY = page * pageRows * cellWidth;
  const copyHeight = Math.min(pageHeight, Math.max(0, height - sourceY));
  for (let y = 0; y < copyHeight; y += 1) {
    pixels.copy(pagePixels, y * width * 4, (sourceY + y) * width * 4, (sourceY + y + 1) * width * 4);
  }
  const fileName = `${prefix}-${String(page).padStart(2, "0")}.png`;
  writePng(path.join(outputDirectory, fileName), pagePixels, pageHeight);
}
console.log(`split ${inputPath} -> ${outputDirectory} (${pageCount} pages, ${width}x${cellWidth * pageRows} max page)`);
