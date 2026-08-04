import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareUnicodeCodePoints)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

export function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

export function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not supported by every Windows filesystem. File
    // descriptors are still fsynced before rename, so this remains best effort.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeDurableFile(path, content, { exclusive = false } = {}) {
  ensureDirectory(dirname(path));
  const descriptor = openSync(path, exclusive ? 'wx' : 'w');
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

export function replaceFileAtomic(sourcePath, targetPath) {
  ensureDirectory(dirname(targetPath));
  renameSync(sourcePath, targetPath);
  fsyncDirectory(dirname(targetPath));
}

export function atomicWriteFile(path, content) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeDurableFile(temporaryPath, content, { exclusive: true });
    replaceFileAtomic(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function atomicWriteJson(path, value) {
  atomicWriteFile(path, serializeJson(value));
}
