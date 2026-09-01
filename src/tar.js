/**
 * Minimal tar reader, enough for `tar czf - .` from GNU tar and bsdtar.
 *
 * Buffers rather than streams: uploads are capped well below the Workers memory
 * limit, and buffering removes a whole class of partial-block bugs.
 */

const BLOCK = 512;

const decodeStr = (bytes) => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
};

/** Tar numeric fields are octal ASCII; GNU also emits a base-256 form for large values. */
function decodeOctal(bytes) {
  if (bytes.length && bytes[0] & 0x80) {
    let n = BigInt(bytes[0] & 0x7f);
    for (let i = 1; i < bytes.length; i++) n = (n << 8n) | BigInt(bytes[i]);
    return Number(n);
  }
  const s = decodeStr(bytes).replace(/[^0-7]/g, '');
  return s ? parseInt(s, 8) : 0;
}

function isZeroBlock(buf, off) {
  for (let i = off; i < off + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

/** Header checksum, computed with the checksum field itself read as spaces. */
function checksumOk(buf, off) {
  const stored = decodeOctal(buf.subarray(off + 148, off + 156));
  let unsigned = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : buf[off + i];
    unsigned += b;
  }
  return unsigned === stored;
}

/** Extract `path=` from a pax extended header payload ("<len> key=value\n" records). */
function paxPath(payload) {
  const text = new TextDecoder().decode(payload);
  const re = /(\d+) ([^=]+)=([\s\S]*?)\n/g;
  let m;
  let found = null;
  while ((m = re.exec(text))) {
    if (m[2] === 'path') found = m[3];
  }
  return found;
}

/** Entries macOS tar sprinkles in that should never become site files. */
function isJunk(name) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return (
    base === '.DS_Store' ||
    base.startsWith('._') ||
    name.includes('PaxHeader/') ||
    name.startsWith('.git/') ||
    name.includes('/.git/')
  );
}

/**
 * @param {Uint8Array} buf raw (already decompressed) tar bytes
 * @returns {Array<{name: string, size: number, data: Uint8Array}>} regular files only
 */
export function parseTar(buf) {
  const files = [];
  let off = 0;
  let pendingName = null; // set by a GNU 'L' or pax 'x' header for the next entry

  while (off + BLOCK <= buf.length) {
    if (isZeroBlock(buf, off)) break;
    if (!checksumOk(buf, off)) throw new Error(`bad tar header at offset ${off}`);

    const typeflag = String.fromCharCode(buf[off + 156]);
    const size = decodeOctal(buf.subarray(off + 124, off + 136));
    const dataOff = off + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataOff + size > buf.length) throw new Error('truncated tar entry');

    if (typeflag === 'L') {
      pendingName = decodeStr(buf.subarray(dataOff, dataOff + size));
    } else if (typeflag === 'x' || typeflag === 'X') {
      pendingName = paxPath(buf.subarray(dataOff, dataOff + size)) ?? pendingName;
    } else if (typeflag === 'g') {
      // global pax header; nothing we need
    } else {
      let name = pendingName;
      if (name === null) {
        name = decodeStr(buf.subarray(off, off + 100));
        const prefix = decodeStr(buf.subarray(off + 345, off + 500));
        if (prefix) name = `${prefix}/${name}`;
      }
      pendingName = null;

      const isFile = typeflag === '0' || typeflag === '\0' || typeflag === '';
      if (isFile && name && !name.endsWith('/') && !isJunk(name)) {
        files.push({ name, size, data: buf.subarray(dataOff, dataOff + size) });
      }
    }

    off = dataOff + padded;
  }
  return files;
}

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decompress if the payload is gzipped, otherwise pass it through.
 *
 * `tar czf -` pads its *output* to a 10 KiB block with NUL bytes, which land
 * after the gzip trailer and make a strict decoder reject the whole stream —
 * so the headline `tar czf - . | curl -T -` flow arrives with junk on the end.
 * Trailing NULs cannot simply be stripped, because the 8-byte trailer itself
 * usually ends in zeros (ISIZE is little-endian). Instead, strip them to find a
 * lower bound and walk forward: the true end is at most 8 bytes past it.
 */
export async function maybeGunzip(bytes) {
  if (!isGzip(bytes)) return bytes;
  try {
    return await inflate(bytes);
  } catch (first) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    if (end === bytes.length) throw first;
    for (let len = end; len <= Math.min(bytes.length, end + 8); len++) {
      try {
        return await inflate(bytes.subarray(0, len));
      } catch { /* not the member boundary; keep looking */ }
    }
    throw first;
  }
}

/** Strip a common leading directory so `tar czf - ./docs` and `cd docs && tar czf - .` agree. */
export function stripCommonPrefix(files) {
  const cleaned = files.map((f) => ({ ...f, name: f.name.replace(/^\.\//, '') }));
  if (cleaned.length === 0) return cleaned;
  const first = cleaned[0].name.split('/');
  if (first.length < 2) return cleaned;
  const candidate = first[0] + '/';
  return cleaned.every((f) => f.name.startsWith(candidate))
    ? cleaned.map((f) => ({ ...f, name: f.name.slice(candidate.length) }))
    : cleaned;
}
