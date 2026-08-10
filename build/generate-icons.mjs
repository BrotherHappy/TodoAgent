#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const buildDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(buildDirectory);
const sourceSvg = path.join(projectDirectory, 'assets', 'app-icon.svg');
const macIcon = path.join(buildDirectory, 'icon.icns');
const windowsIcon = path.join(buildDirectory, 'icon.ico');

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

function run(command, args) {
  execFileSync(command, args, { stdio: 'pipe' });
}

function findChrome() {
  for (const candidate of chromeCandidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next Chromium-based browser.
    }
  }
  throw new Error('Set CHROME_PATH to a Chromium-based browser executable.');
}

function readPngSize(filePath) {
  const data = readFileSync(filePath);
  const signature = '89504e470d0a1a0a';
  if (data.subarray(0, 8).toString('hex') !== signature) {
    throw new Error(`${filePath} is not a PNG file.`);
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

function assertPngSize(filePath, size) {
  const dimensions = readPngSize(filePath);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(
      `${filePath} is ${dimensions.width}x${dimensions.height}; expected ${size}x${size}.`,
    );
  }
}

function resizePng(masterPath, outputPath, size) {
  run('/usr/bin/sips', [
    '-z', String(size), String(size), masterPath, '--out', outputPath,
  ]);
  assertPngSize(outputPath, size);
}

function writeIco(entries, outputPath) {
  const headerSize = 6 + entries.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let imageOffset = headerSize;
  entries.forEach(({ size, data }, index) => {
    const offset = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, offset);
    header.writeUInt8(size === 256 ? 0 : size, offset + 1);
    header.writeUInt8(0, offset + 2);
    header.writeUInt8(0, offset + 3);
    header.writeUInt16LE(1, offset + 4);
    header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(data.length, offset + 8);
    header.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += data.length;
  });
  writeFileSync(outputPath, Buffer.concat([
    header,
    ...entries.map(({ data }) => data),
  ]));
}

function verifyIco(filePath, expectedSizes) {
  const data = readFileSync(filePath);
  if (data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) {
    throw new Error(`${filePath} has an invalid ICO header.`);
  }
  const count = data.readUInt16LE(4);
  if (count !== expectedSizes.length) {
    throw new Error(`${filePath} contains ${count} images; expected ${expectedSizes.length}.`);
  }
  const sizes = Array.from({ length: count }, (_, index) => {
    const width = data.readUInt8(6 + index * 16);
    return width === 0 ? 256 : width;
  });
  if (sizes.join(',') !== expectedSizes.join(',')) {
    throw new Error(`${filePath} has unexpected sizes: ${sizes.join(', ')}.`);
  }
}

function verifyIcns(filePath) {
  const data = readFileSync(filePath);
  if (
    data.subarray(0, 4).toString('ascii') !== 'icns' ||
    data.readUInt32BE(4) !== data.length
  ) {
    throw new Error(`${filePath} has an invalid ICNS container.`);
  }
}

const workDirectory = mkdtempSync(path.join(tmpdir(), 'todo-agent-icons-'));
try {
  mkdirSync(buildDirectory, { recursive: true });
  const masterPng = path.join(workDirectory, 'icon-1024.png');
  run(findChrome(), [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    '--window-size=1024,1024',
    `--screenshot=${masterPng}`,
    pathToFileURL(sourceSvg).href,
  ]);
  assertPngSize(masterPng, 1024);

  const iconsetDirectory = path.join(workDirectory, 'icon.iconset');
  mkdirSync(iconsetDirectory);
  const macRepresentations = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];
  for (const [fileName, size] of macRepresentations) {
    resizePng(masterPng, path.join(iconsetDirectory, fileName), size);
  }
  rmSync(macIcon, { force: true });
  run('/usr/bin/iconutil', ['-c', 'icns', iconsetDirectory, '-o', macIcon]);
  verifyIcns(macIcon);

  const windowsSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const windowsEntries = windowsSizes.map((size) => {
    const filePath = path.join(workDirectory, `windows-${size}.png`);
    resizePng(masterPng, filePath, size);
    return { size, data: readFileSync(filePath) };
  });
  writeIco(windowsEntries, windowsIcon);
  verifyIco(windowsIcon, windowsSizes);

  process.stdout.write(
    `Generated build/icon.icns and build/icon.ico from assets/app-icon.svg.\n`,
  );
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
