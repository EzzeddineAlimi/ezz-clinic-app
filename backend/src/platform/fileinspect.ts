/*
 * Patient-document byte inspection (R73-D). Pure functions on untrusted bytes; never trusts a file name or a
 * client-declared type.
 *   detectType      magic bytes only: JPEG, PNG, PDF, DICOM Part 10 ("DICM" at offset 128). Anything else is refused.
 *   stripLocation   removes location-bearing metadata the clinic does not need: the EXIF GPS directory and XMP packets
 *                   in JPEG, eXIf and XMP text chunks in PNG. Pixel data and other tags (e.g. orientation) are kept.
 *                   PDF and DICOM are stored byte-for-byte (DICOM headers carry identity fields and are NOT inspected).
 *   structuralScreen  a FORMAT check, NOT a malware scanner: well-formed container, no trailing bytes after the end
 *                   marker (polyglot files), and for PDF no active-content keywords (JavaScript, launch actions,
 *                   embedded files, XFA, rich media) in the uncompressed text. Content inside compressed streams is
 *                   invisible to it. Choosing a real malware scanner is an operations decision (docs/product/patient-documents.md).
 * No image is decoded or interpreted; nothing here makes a clinical statement about content.
 */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf', 'application/dicom'] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];
export const EXTENSION: Record<DocumentType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf', 'application/dicom': 'dcm' };

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectType(b: Buffer): DocumentType | null {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 132 && b.subarray(128, 132).toString('latin1') === 'DICM') return 'application/dicom';
  return null;
}

/* ------------------------------------------------------------------------------------------------ JPEG */

interface JpegSegment { marker: number; start: number; end: number } // [start, end) includes the FF xx marker bytes

/** Walk JPEG marker segments up to SOS; returns the segments and the offset where SOS starts (null if malformed). */
function jpegSegments(b: Buffer): { segments: JpegSegment[]; sos: number } | null {
  const segments: JpegSegment[] = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xda) return { segments, sos: i };
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    segments.push({ marker, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  return null;
}

const EXIF_ID = Buffer.from('Exif\0\0', 'latin1');
const XMP_IDS = ['http://ns.adobe.com/xap/1.0/\0', 'http://ns.adobe.com/xmp/extension/\0'].map(s => Buffer.from(s, 'latin1'));
const TIFF_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Blank the GPS IFD inside a TIFF block in place. Returns 'none' | 'removed' | 'unparseable'. */
function blankGps(tiff: Buffer): 'none' | 'removed' | 'unparseable' {
  if (tiff.length < 8) return 'unparseable';
  const order = tiff.subarray(0, 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return 'unparseable';
  const le = order === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return 'unparseable';
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return 'unparseable';
  const n = u16(ifd0);
  if (ifd0 + 2 + n * 12 > tiff.length) return 'unparseable';
  let gps = -1;
  for (let k = 0; k < n; k++) if (u16(ifd0 + 2 + k * 12) === 0x8825) gps = u32(ifd0 + 2 + k * 12 + 8);
  if (gps < 0) return 'none';
  if (gps + 2 > tiff.length) return 'unparseable';
  const m = u16(gps);
  const ifdEnd = gps + 2 + m * 12 + 4;
  if (ifdEnd > tiff.length) return 'unparseable';
  for (let k = 0; k < m; k++) {
    const e = gps + 2 + k * 12;
    const size = (TIFF_TYPE_SIZE[u16(e + 2)] ?? 0) * u32(e + 4);
    if (size > 4) {
      const off = u32(e + 8);
      if (off + size > tiff.length) return 'unparseable';
      tiff.fill(0, off, off + size);
    }
  }
  tiff.fill(0, gps, ifdEnd); // an IFD with zero entries and no next IFD: the GPS pointer stays valid but leads nowhere
  return m > 0 ? 'removed' : 'none';
}

function stripJpeg(b: Buffer): { bytes: Buffer; removed: string[] } {
  const parsed = jpegSegments(b);
  if (!parsed) return { bytes: b, removed: [] };
  const parts: Buffer[] = [b.subarray(0, 2)];
  const removed = new Set<string>();
  for (const s of parsed.segments) {
    const seg = Buffer.from(b.subarray(s.start, s.end)); // copy: never mutate the caller's buffer
    if (s.marker === 0xe1) {
      const body = seg.subarray(4);
      if (XMP_IDS.some(id => body.subarray(0, id.length).equals(id))) { removed.add('XMP'); continue; }
      if (body.subarray(0, 6).equals(EXIF_ID)) {
        const r = blankGps(body.subarray(6));
        if (r === 'unparseable') { removed.add('EXIF_UNPARSEABLE'); continue; } // fail safe: drop the whole block
        if (r === 'removed') removed.add('EXIF_GPS');
      }
    }
    parts.push(seg);
  }
  parts.push(b.subarray(parsed.sos));
  return { bytes: Buffer.concat(parts), removed: [...removed].sort() };
}

/* ------------------------------------------------------------------------------------------------ PNG */

interface PngChunk { type: string; start: number; end: number; dataStart: number; dataEnd: number }

function pngChunks(b: Buffer): PngChunk[] | null {
  const out: PngChunk[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end > b.length) return null;
    if (crc32(b.subarray(i + 4, i + 8 + len)) !== b.readUInt32BE(i + 8 + len)) return null;
    out.push({ type, start: i, end, dataStart: i + 8, dataEnd: i + 8 + len });
    i = end;
    if (type === 'IEND') return i === b.length ? out : null;
  }
  return null;
}

function stripPng(b: Buffer): { bytes: Buffer; removed: string[] } {
  const chunks = pngChunks(b);
  if (!chunks) return { bytes: b, removed: [] };
  const parts: Buffer[] = [b.subarray(0, 8)];
  const removed = new Set<string>();
  for (const c of chunks) {
    if (c.type === 'eXIf') { removed.add('EXIF'); continue; }
    if ((c.type === 'iTXt' || c.type === 'tEXt' || c.type === 'zTXt') && b.subarray(c.dataStart, c.dataEnd).toString('latin1').startsWith('XML:com.adobe.xmp\0')) { removed.add('XMP'); continue; }
    parts.push(b.subarray(c.start, c.end));
  }
  return { bytes: Buffer.concat(parts), removed: [...removed].sort() };
}

/** Remove location-bearing metadata. Returns the bytes to store and what was removed (empty when nothing was). */
export function stripLocation(b: Buffer, type: DocumentType): { bytes: Buffer; removed: string[] } {
  if (type === 'image/jpeg') return stripJpeg(b);
  if (type === 'image/png') return stripPng(b);
  return { bytes: b, removed: [] };
}

/** Does the image still carry an EXIF GPS directory with entries? (Used by tests and the integrity check.) */
export function hasGpsMetadata(b: Buffer): boolean {
  const parsed = detectType(b) === 'image/jpeg' ? jpegSegments(b) : null;
  if (!parsed) return false;
  for (const s of parsed.segments) {
    const body = b.subarray(s.start + 4, s.end);
    if (s.marker === 0xe1 && body.subarray(0, 6).equals(EXIF_ID)) {
      const probe = Buffer.from(body.subarray(6));
      if (blankGps(probe) === 'removed') return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------------------------------ screening */

export type ScreenVerdict = 'PASS' | 'REJECT' | 'UNAVAILABLE';
export interface ScreenResult { verdict: ScreenVerdict; reason: string | null }
/** Pluggable content screening. A production malware scanner implements this; the default below is format-only. */
export interface ContentScreener { readonly name: string; screen(bytes: Buffer, type: DocumentType): Promise<ScreenResult> }

const PDF_ACTIVE = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/EmbeddedFiles', '/RichMedia', '/XFA', '/SubmitForm', '/ImportData'];

/** PDF names may hide letters as #xx escapes (/J#61vaScript); normalise before matching. */
const pdfNormalise = (s: string) => s.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

export function structuralCheck(b: Buffer, type: DocumentType): ScreenResult {
  const reject = (reason: string): ScreenResult => ({ verdict: 'REJECT', reason });
  if (type === 'image/jpeg') {
    const parsed = jpegSegments(b);
    if (!parsed) return reject('JPEG marker structure is malformed');
    if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return reject('JPEG does not end with its end-of-image marker (trailing data)');
  } else if (type === 'image/png') {
    if (!pngChunks(b)) return reject('PNG chunk structure or checksum is invalid, or data follows IEND');
  } else if (type === 'application/pdf') {
    const text = pdfNormalise(b.toString('latin1'));
    if (!/%%EOF\s*$/.test(text.slice(-1024))) return reject('PDF does not end with %%EOF (truncated or trailing data)');
    const hit = PDF_ACTIVE.find(k => new RegExp(k.replace('/', '\\/') + '(?![A-Za-z])').test(text));
    if (hit) return reject(`PDF contains active content (${hit}); not accepted`);
  } else if (type === 'application/dicom') {
    if (b.length < 136 || b.readUInt16LE(132) !== 0x0002) return reject('DICOM file meta information group (0002) missing after the preamble');
  }
  return { verdict: 'PASS', reason: null };
}

/** Default screener: format checks only. It is honest about it in its name; it does not claim malware detection. */
export const structuralScreener: ContentScreener = {
  name: 'structural-format-check-v1 (not a malware scanner)',
  async screen(bytes, type) { return structuralCheck(bytes, type); },
};
