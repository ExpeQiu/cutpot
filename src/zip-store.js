import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

function dosDate(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

async function hashFile(file) {
  const handle = await open(file, 'r');
  try {
    let value = 0, size = 0;
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      value = crc32(buf.subarray(0, bytesRead), value);
      size += bytesRead;
    }
    return { crc: value >>> 0, size };
  } finally { await handle.close(); }
}

/** Pack STORE-method zip entries. Each entry: {name, path} or {name, data:Buffer|string}. */
export async function writeZip(outFile, entries) {
  const out = createWriteStream(outFile);
  const central = [];
  let offset = 0;
  const { time, day } = dosDate();
  const write = chunk => new Promise((resolve, reject) => {
    const ok = out.write(chunk, err => err ? reject(err) : resolve());
    if (!ok) out.once('drain', resolve);
    else resolve();
  });
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 0xffff) throw new Error(`压缩包内路径过长：${entry.name}`);
    let crc, size, source;
    if (entry.path) {
      const info = await hashFile(entry.path);
      crc = info.crc; size = info.size; source = entry.path;
      if (size >= 0xffffffff) throw new Error(`素材过大，暂不支持写入压缩包：${entry.name}`);
    } else {
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
      crc = crc32(data) >>> 0; size = data.length; source = data;
    }
    const local = Buffer.concat([
      u32(LOCAL), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(size), u32(size), u16(name.length), u16(0), name
    ]);
    central.push({ name, crc, size, offset, time, day });
    await write(local);
    offset += local.length;
    if (Buffer.isBuffer(source)) {
      await write(source);
      offset += source.length;
    } else {
      await new Promise((resolve, reject) => {
        const input = createReadStream(source);
        const onDrain = () => input.resume();
        out.on('drain', onDrain);
        input.on('error', err => { out.off('drain', onDrain); reject(err); });
        input.on('data', chunk => {
          offset += chunk.length;
          if (!out.write(chunk)) input.pause();
        });
        input.on('end', () => { out.off('drain', onDrain); resolve(); });
      });
    }
  }
  const centralStart = offset;
  for (const item of central) {
    const record = Buffer.concat([
      u32(CENTRAL), u16(20), u16(20), u16(0x0800), u16(0), u16(item.time), u16(item.day),
      u32(item.crc), u32(item.size), u32(item.size), u16(item.name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(item.offset), item.name
    ]);
    await write(record);
    offset += record.length;
  }
  if (central.length > 0xffff || centralStart >= 0xffffffff || offset >= 0xffffffff) {
    throw new Error('工程压缩包过大，请减少素材后重试');
  }
  const end = Buffer.concat([
    u32(EOCD), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(offset - centralStart), u32(centralStart), u16(0)
  ]);
  await write(end);
  await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  return { bytes: (await stat(outFile)).size, files: central.length };
}

function findEocd(buffer) {
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error('不是有效的 CutPot 工程压缩包');
}

/** List STORE zip entries. Returns [{name, size, offset, crc}]. offset is data start. */
export async function listZip(file) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw new Error('不是有效的 CutPot 工程压缩包');
    const tailSize = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    const eocd = findEocd(tail);
    const abs = size - tailSize + eocd;
    const total = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    const entries = [];
    let pos = 0;
    for (let i = 0; i < total; i++) {
      if (central.readUInt32LE(pos) !== CENTRAL) throw new Error('工程压缩包目录损坏');
      const compression = central.readUInt16LE(pos + 10);
      const crc = central.readUInt32LE(pos + 16);
      const sizeStored = central.readUInt32LE(pos + 20);
      const nameLen = central.readUInt16LE(pos + 28);
      const extraLen = central.readUInt16LE(pos + 30);
      const commentLen = central.readUInt16LE(pos + 32);
      const localOffset = central.readUInt32LE(pos + 42);
      const name = central.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
      if (compression !== 0) throw new Error(`暂不支持压缩条目：${name}`);
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== LOCAL) throw new Error(`工程压缩包条目损坏：${name}`);
      const localName = local.readUInt16LE(26), localExtra = local.readUInt16LE(28);
      entries.push({ name, size: sizeStored, crc, offset: localOffset + 30 + localName + localExtra });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally { await handle.close(); }
}

export async function extractZipEntry(zipFile, entry, outFile) {
  const handle = await open(zipFile, 'r');
  try {
    const out = createWriteStream(outFile);
    let remaining = entry.size, value = 0;
    const buf = Buffer.alloc(1024 * 1024);
    let position = entry.offset;
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, remaining), position);
      if (!bytesRead) throw new Error(`工程压缩包读取中断：${entry.name}`);
      value = crc32(buf.subarray(0, bytesRead), value);
      remaining -= bytesRead;
      position += bytesRead;
      if (!out.write(buf.subarray(0, bytesRead))) await new Promise(r => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    if ((value >>> 0) !== (entry.crc >>> 0)) throw new Error(`工程压缩包校验失败：${entry.name}`);
  } finally { await handle.close(); }
}

export async function readZipText(zipFile, entry) {
  const handle = await open(zipFile, 'r');
  try {
    if (entry.size > 64 * 1024 * 1024) throw new Error('工程描述文件过大');
    const buf = Buffer.alloc(entry.size);
    await handle.read(buf, 0, entry.size, entry.offset);
    if ((crc32(buf) >>> 0) !== (entry.crc >>> 0)) throw new Error(`工程描述文件校验失败：${entry.name}`);
    return buf.toString('utf8');
  } finally { await handle.close(); }
}
