// Typed IPP (RFC 8010/8011) wire codec, ported from tools/ipp-spike/ipp.mjs (proven against Windows 11 + Android).
// Attribute shape: { name, tag, values }. A collection value is an array of member attributes (IppAttr[]).

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
} as const;

export const OP = {
  printJob: 0x0002,
  validateJob: 0x0004,
  createJob: 0x0005,
  sendDocument: 0x0006,
  cancelJob: 0x0008,
  getJobAttributes: 0x0009,
  getJobs: 0x000a,
  getPrinterAttributes: 0x000b,
} as const;

export const OP_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(OP).map(([k, v]) => [v, k]),
);

export const STATUS = {
  ok: 0x0000,
  badRequest: 0x0400,
  notAuthorized: 0x0401,
  notPossible: 0x0404,
  notFound: 0x0406,
  requestEntityTooLarge: 0x0408,
  documentFormatNotSupported: 0x040a,
  documentFormatError: 0x0412,
  internalError: 0x0500,
  operationNotSupported: 0x0501,
  temporaryError: 0x0506,
} as const;

export interface IppResolution {
  x: number;
  y: number;
  units: number;
}

export type IppRange = [number, number];

/** Decoded dateTime values are strings; Date is accepted for encoding. */
export type IppValue = number | boolean | string | Date | IppRange | IppResolution | IppAttr[];

export interface IppAttr {
  name: string;
  tag: number;
  values: IppValue[];
}

export interface IppGroup {
  tag: number;
  attrs: IppAttr[];
}

export interface IppMessage {
  version: string;
  code: number;
  requestId: number;
  groups: IppGroup[];
  /** Trailing document bytes (Print-Job / Send-Document). */
  doc: Buffer;
}

export class IppParseError extends Error {}

export const attr = (tag: number, name: string, ...values: IppValue[]): IppAttr => ({ name, tag, values });

// ---------- decode ----------

function need(buf: Buffer, pos: number, len: number): void {
  if (pos + len > buf.length) throw new IppParseError("truncated IPP message");
}

function decodeScalar(tag: number, buf: Buffer): IppValue {
  switch (tag) {
    case TAG.integer:
    case TAG.enum:
      return buf.length >= 4 ? buf.readInt32BE(0) : 0;
    case TAG.boolean:
      return buf[0] !== 0;
    case TAG.resolution:
      if (buf.length < 9) throw new IppParseError("bad resolution value");
      return { x: buf.readInt32BE(0), y: buf.readInt32BE(4), units: buf[8] ?? 3 };
    case TAG.range:
      if (buf.length < 8) throw new IppParseError("bad rangeOfInteger value");
      return [buf.readInt32BE(0), buf.readInt32BE(4)];
    case TAG.octet:
      return buf.toString("hex");
    case TAG.dateTime:
      return buf.length >= 11
        ? `${buf.readUInt16BE(0)}-${buf[2]}-${buf[3]}T${buf[4]}:${buf[5]}:${buf[6]}`
        : "";
    case TAG.textLang:
    case TAG.nameLang: {
      // 2-byte lang length, lang, 2-byte text length, text
      try {
        const ll = buf.readUInt16BE(0);
        const tl = buf.readUInt16BE(2 + ll);
        return buf.subarray(4 + ll, 4 + ll + tl).toString("utf8");
      } catch {
        return buf.toString("utf8");
      }
    }
    default:
      return buf.toString("utf8");
  }
}

const MAX_COLLECTION_DEPTH = 8;

/** Parse a collection body starting just after the begCollection value header. */
function parseCollection(buf: Buffer, start: number, depth: number): { members: IppAttr[]; pos: number } {
  if (depth > MAX_COLLECTION_DEPTH) throw new IppParseError("collection nested too deeply");
  const members: IppAttr[] = [];
  let current: IppAttr | null = null;
  let pos = start;
  for (;;) {
    need(buf, pos, 5);
    const tag = buf[pos++] as number;
    const nameLen = buf.readUInt16BE(pos);
    pos += 2;
    need(buf, pos, nameLen + 2);
    pos += nameLen;
    const valLen = buf.readUInt16BE(pos);
    pos += 2;
    if (tag === TAG.endCollection) return { members, pos };
    need(buf, pos, valLen);
    if (tag === TAG.memberName) {
      current = { name: buf.toString("utf8", pos, pos + valLen), tag: 0, values: [] };
      members.push(current);
      pos += valLen;
      continue;
    }
    if (!current) throw new IppParseError("collection value before member name");
    if (tag === TAG.begCollection) {
      const sub = parseCollection(buf, pos + valLen, depth + 1);
      current.tag = tag;
      current.values.push(sub.members);
      pos = sub.pos;
      continue;
    }
    current.tag = tag;
    current.values.push(decodeScalar(tag, buf.subarray(pos, pos + valLen)));
    pos += valLen;
  }
}

/** Decode an IPP message. Throws IppParseError on anything malformed. */
export function decodeIpp(buf: Buffer): IppMessage {
  if (buf.length < 8) throw new IppParseError("IPP message too short");
  const version = `${buf[0]}.${buf[1]}`;
  const code = buf.readUInt16BE(2);
  const requestId = buf.readUInt32BE(4);
  const groups: IppGroup[] = [];
  let group: IppGroup | null = null;
  let last: IppAttr | null = null;
  let pos = 8;
  for (;;) {
    if (pos >= buf.length) throw new IppParseError("missing end-of-attributes");
    const tag = buf[pos++] as number;
    if (tag === TAG.end) break;
    if (tag <= 0x0f) {
      group = { tag, attrs: [] };
      groups.push(group);
      last = null;
      continue;
    }
    if (!group) throw new IppParseError("attribute outside of a group");
    need(buf, pos, 2);
    const nameLen = buf.readUInt16BE(pos);
    pos += 2;
    need(buf, pos, nameLen + 2);
    const name = buf.toString("utf8", pos, pos + nameLen);
    pos += nameLen;
    const valLen = buf.readUInt16BE(pos);
    pos += 2;
    let value: IppValue;
    if (tag === TAG.begCollection) {
      const col = parseCollection(buf, pos + valLen, 1);
      value = col.members;
      pos = col.pos;
    } else {
      need(buf, pos, valLen);
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

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const i32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

function encodeScalar(tag: number, v: IppValue): Buffer {
  if (tag === TAG.integer || tag === TAG.enum) return i32(v as number);
  if (tag === TAG.boolean) return Buffer.from([v ? 1 : 0]);
  if (tag === TAG.resolution) {
    const r = v as IppResolution;
    return Buffer.concat([i32(r.x), i32(r.y), Buffer.from([r.units ?? 3])]);
  }
  if (tag === TAG.range) {
    const r = v as IppRange;
    return Buffer.concat([i32(r[0]), i32(r[1])]);
  }
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
  return Buffer.from(String(v), "utf8");
}

function encodeValueRecord(tag: number, nameBuf: Buffer, value: IppValue): Buffer {
  if (tag === TAG.begCollection) {
    const parts: Buffer[] = [Buffer.from([tag]), u16(nameBuf.length), nameBuf, u16(0)];
    for (const m of value as IppAttr[]) {
      const mn = Buffer.from(m.name, "utf8");
      parts.push(Buffer.from([TAG.memberName]), u16(0), u16(mn.length), mn);
      for (const mv of m.values) parts.push(encodeValueRecord(m.tag, Buffer.alloc(0), mv));
    }
    parts.push(Buffer.from([TAG.endCollection]), u16(0), u16(0));
    return Buffer.concat(parts);
  }
  const data = encodeScalar(tag, value);
  return Buffer.concat([Buffer.from([tag]), u16(nameBuf.length), nameBuf, u16(data.length), data]);
}

function encodeAttr(a: IppAttr): Buffer {
  const nameBuf = Buffer.from(a.name, "utf8");
  return Buffer.concat(
    a.values.map((v, i) => encodeValueRecord(a.tag, i === 0 ? nameBuf : Buffer.alloc(0), v)),
  );
}

export interface EncodeInput {
  version?: string;
  code: number;
  requestId: number;
  groups: IppGroup[];
}

export function encodeIpp({ version = "2.0", code, requestId, groups }: EncodeInput): Buffer {
  const [maj, min] = version.split(".").map(Number);
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32BE(requestId >>> 0);
  const parts: Buffer[] = [Buffer.from([maj ?? 2, min ?? 0]), u16(code), idBuf];
  for (const g of groups) {
    parts.push(Buffer.from([g.tag]));
    for (const a of g.attrs) parts.push(encodeAttr(a));
  }
  parts.push(Buffer.from([TAG.end]));
  return Buffer.concat(parts);
}

// ---------- flatten ----------

export type FlatValue = number | boolean | string | Date | IppRange | IppResolution | FlatObject | FlatValue[];
export interface FlatObject {
  [key: string]: FlatValue;
}

const isCollection = (v: IppValue): v is IppAttr[] =>
  Array.isArray(v) && v.length > 0 && typeof (v[0] as IppAttr | undefined)?.name === "string" && "values" in (v[0] as object);

function flattenMembers(members: IppAttr[]): FlatObject {
  const out: FlatObject = {};
  for (const m of members) {
    const vals = m.values.map((v) => (isCollection(v) ? flattenMembers(v) : (v as FlatValue)));
    out[m.name] = vals.length === 1 ? (vals[0] as FlatValue) : vals;
  }
  return out;
}

/** Flatten a group to a plain object { name: value | [values] }, exactly as the spike's flatten() does. */
export function flatten(group: IppGroup | undefined): FlatObject {
  return flattenMembers(group?.attrs ?? []);
}
