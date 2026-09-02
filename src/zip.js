/**
 * Minimal zip reader, enough for what a person drags out of a file manager.
 *
 * Reads the central directory rather than scanning local headers, because a
 * local header may declare sizes of zero and defer them to a data descriptor
 * after the data — the central directory always has the real values.
 *
 * Supports stored (method 0) and deflate (method 8), which is everything the
 * macOS and Windows "compress" commands produce.
 */

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export const looksLikeZip = (b) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);

/** Scan backwards for the end-of-central-directory record. */
function findEocd(buf) {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - max && i >= 0; i--) {
    if (u32(buf, i) === EOCD) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries a file manager adds that should never become site files. */
function isJunk(name) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return (
    name.startsWith('__MACOSX/') ||
    name.includes('/__MACOSX/') ||
    base === '.DS_Store' ||
    base.startsWith('._') ||
    name.startsWith('.git/') ||
    name.includes('/.git/')
  );
}

/**
 * @param {Uint8Array} buf a complete zip archive
 * @returns {Promise<Array<{name: string, size: number, data: Uint8Array}>>} files only
 */
export async function parseZip(buf) {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error('not a zip archive');
  if (u32(buf, Math.max(0, eocd - 20)) === EOCD64_LOCATOR) {
    throw new Error('zip64 archives are not supported');
  }

  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16);
  const files = [];

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || u32(buf, off) !== CENTRAL) throw new Error('corrupt zip directory');
    const method = u16(buf, off + 10);
    const compressed = u32(buf, off + 20);
    const uncompressed = u32(buf, off + 24);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const localOff = u32(buf, off + 42);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || isJunk(name)) continue;
    if (localOff + 30 > buf.length || u32(buf, localOff) !== LOCAL) throw new Error('corrupt zip entry');

    // The local header's own name and extra lengths are authoritative for
    // where the data starts; they can differ from the central directory's.
    const dataStart = localOff + 30 + u16(buf, localOff + 26) + u16(buf, localOff + 28);
    if (dataStart + compressed > buf.length) throw new Error('truncated zip entry');
    const raw = buf.subarray(dataStart, dataStart + compressed);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`unsupported zip compression method ${method}`);

    if (data.length !== uncompressed) throw new Error(`size mismatch for ${name}`);
    files.push({ name, size: data.length, data });
  }
  return files;
}
