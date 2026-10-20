// Minimal IPP (RFC 8010/8011) wire codec - just enough for the Phase 0 spike.
// Attribute shape: { name, tag, values: [...] }. Collection values are arrays of attributes.

export const TAG = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
  unsupported: 0x05,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  octet: 0x30,
  dateTime: 0x31,
  resolution: 0x32,
  range: 0x33,
  begCollection: 0x34,
  textLang: 0x35,
  nameLang: 0x36,
  endCollection: 0x37,
  text: 0x41,
  name: 0x42,
  keyword: 0x44,
  uri: 0x45,
  uriScheme: 0x46,
  charset: 0x47,
  language: 0x48,
  mime: 0x49,
  memberName: 0x4a,
};

export const OP = {
  printJob: 0x0002,
  validateJob: 0x0004,
  createJob: 0x0005,
  sendDocument: 0x0006,
  cancelJob: 0x0008,
  getJobAttributes: 0x0009,
  getJobs: 0x000a,
  getPrinterAttributes: 0x000b,
};

export const OP_NAMES = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

export const STATUS = {
  ok: 0x0000,
  badRequest: 0x0400,
  notFound: 0x0406,
  operationNotSupported: 0x0501,
};

const STRING_TAGS = new Set([
  TAG.text, TAG.name, TAG.keyword, TAG.uri, TAG.uriScheme, TAG.charset, TAG.language, TAG.mime,
]);

export const attr = (tag, name, ...values) => ({ name, tag, values });

// ---------- decode ----------

function decodeScalar(tag, buf) {
  switch (tag) {
    case TAG.integer:
    case TAG.enum:
      return buf.length >= 4 ? buf.readInt32BE(0) : 0;
    case TAG.boolean:
      return buf[0] !== 0;
    case TAG.resolution:
      return { x: buf.readInt32BE(0), y: buf.readInt32BE(4), units: buf[8] };
    case TAG.range:
      return [buf.readInt32BE(0), buf.readInt32BE(4)];
    case TAG.octet:
      return buf.toString('hex');
    case TAG.dateTime:
      return buf.length >= 11
        ? `${buf.readUInt16BE(0)}-${buf[2]}-${buf[3]}T${buf[4]}:${buf[5]}:${buf[6]}`
        : '';
    case TAG.textLang:
    case TAG.nameLang: {
      // 2-byte lang length, lang, 2-byte text length, text
      try {
        const ll = buf.readUInt16BE(0);
        const tl = buf.readUInt16BE(2 + ll);
        return buf.subarray(4 + ll, 4 + ll + tl).toString('utf8');
      } catch {
        return buf.toString('utf8');
      }
    }
    default:
      return buf.toString('utf8');
  }
}

// Parse a collection body starting just after the begCollection value header.
function parseCollection(buf, pos) {
  const members = [];
  let current = null;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated collection');
    const tag = buf[pos++];
    const nameLen = buf.readUInt16BE(pos);
    pos += 2;
    const name = buf.toString('utf8', pos, pos + nameLen);
    pos += nameLen;
    const valLen = buf.readUInt16BE(pos);
    pos += 2;
    if (tag === TAG.endCollection) return { members, pos };
    if (tag === TAG.memberName) {
      current = { name: buf.toString('utf8', pos, pos + valLen), tag: 0, values: [] };
      members.push(current);
      pos += valLen;
      continue;
    }
    if (!current) throw new Error('collection value before member name');
    if (tag === TAG.begCollection) {
      const sub = parseCollection(buf, pos + valLen);
      current.tag = tag;
      current.values.push(sub.members);
      pos = sub.pos;
      continue;
    }
    void name;
    current.tag = tag;
    current.values.push(decodeScalar(tag, buf.subarray(pos, pos + valLen)));
    pos += valLen;
  }
}

/** Decode an IPP message. Returns { version, code, requestId, groups, doc } where doc is the trailing document bytes. */
export function decodeIpp(buf) {
  if (buf.length < 8) throw new Error('IPP message too short');
  const version = `${buf[0]}.${buf[1]}`;
  const code = buf.readUInt16BE(2);
  const requestId = buf.readUInt32BE(4);
  const groups = [];
  let group = null;
  let last = null;
  let pos = 8;
  for (;;) {
    if (pos >= buf.length) throw new Error('missing end-of-attributes');
    const tag = buf[pos++];
    if (tag === TAG.end) break;
    if (tag <= 0x0f) {
      group = { tag, attrs: [] };
      groups.push(group);
      last = null;
      continue;
    }
    if (!group) throw new Error('attribute outside of a group');
    const nameLen = buf.readUInt16BE(pos);
    pos += 2;
    const name = buf.toString('utf8', pos, pos + nameLen);
    pos += nameLen;
    const valLen = buf.readUInt16BE(pos);
    pos += 2;
    let value;
    if (tag === TAG.begCollection) {
      const col = parseCollection(buf, pos + valLen);
      value = col.members;
      pos = col.pos;
    } else {
      value = decodeScalar(tag, buf.subarray(pos, pos + valLen));
      pos += valLen;
    }
    if (nameLen === 0 && last) {
      last.values.push(value);
    } else {
      last = { name, tag, values: [value] };
      group.attrs.push(last);
    }
  }
  return { version, code, requestId, groups, doc: buf.subarray(pos) };
}

// ---------- encode ----------

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

function encodeScalar(tag, v) {
  if (tag === TAG.integer || tag === TAG.enum) return i32(v);
  if (tag === TAG.boolean) return Buffer.from([v ? 1 : 0]);
  if (tag === TAG.resolution) return Buffer.concat([i32(v.x), i32(v.y), Buffer.from([v.units ?? 3])]);
  if (tag === TAG.range) return Buffer.concat([i32(v[0]), i32(v[1])]);
  if (tag === TAG.dateTime) {
    const d = v instanceof Date ? v : new Date();
    const b = Buffer.alloc(11);
    b.writeUInt16BE(d.getUTCFullYear(), 0);
    b[2] = d.getUTCMonth() + 1;
    b[3] = d.getUTCDate();
    b[4] = d.getUTCHours();
    b[5] = d.getUTCMinutes();
    b[6] = d.getUTCSeconds();
    b[7] = 0;
    b[8] = 0x2b; // '+'
    return b;
  }
  return Buffer.from(String(v), 'utf8');
}

function encodeValueRecord(tag, nameBuf, value, inCollection) {
  if (tag === TAG.begCollection) {
    const parts = [Buffer.from([tag]), u16(nameBuf.length), nameBuf, u16(0)];
    for (const m of value) {
      const mn = Buffer.from(m.name, 'utf8');
      parts.push(Buffer.from([TAG.memberName]), u16(0), u16(mn.length), mn);
      m.values.forEach((mv) => parts.push(encodeValueRecord(m.tag, Buffer.alloc(0), mv, true)));
    }
    parts.push(Buffer.from([TAG.endCollection]), u16(0), u16(0));
    return Buffer.concat(parts);
  }
  void inCollection;
  const data = encodeScalar(tag, value);
  return Buffer.concat([Buffer.from([tag]), u16(nameBuf.length), nameBuf, u16(data.length), data]);
}

function encodeAttr(a) {
  const nameBuf = Buffer.from(a.name, 'utf8');
  return Buffer.concat(
    a.values.map((v, i) => encodeValueRecord(a.tag, i === 0 ? nameBuf : Buffer.alloc(0), v, false)),
  );
}

/** groups: [{ tag, attrs: [attr(...)] }] */
export function encodeIpp({ version = '2.0', code, requestId, groups }) {
  const [maj, min] = version.split('.').map(Number);
  const parts = [Buffer.from([maj, min]), u16(code), Buffer.alloc(4)];
  parts[2].writeUInt32BE(requestId);
  for (const g of groups) {
    parts.push(Buffer.from([g.tag]));
    for (const a of g.attrs) parts.push(encodeAttr(a));
  }
  parts.push(Buffer.from([TAG.end]));
  return Buffer.concat(parts);
}

/** Flatten decoded groups to a plain object for logging: { name: value | [values] }. */
export function flatten(group) {
  const out = {};
  for (const a of group?.attrs ?? []) {
    const vals = a.values.map((v) =>
      Array.isArray(v) && v.length && v[0]?.name ? flattenMembers(v) : v,
    );
    out[a.name] = vals.length === 1 ? vals[0] : vals;
  }
  return out;
}

function flattenMembers(members) {
  const out = {};
  for (const m of members) {
    const vals = m.values.map((v) => (Array.isArray(v) && v.length && v[0]?.name ? flattenMembers(v) : v));
    out[m.name] = vals.length === 1 ? vals[0] : vals;
  }
  return out;
}

export { STRING_TAGS };
