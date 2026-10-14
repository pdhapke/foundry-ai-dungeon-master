import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { TunnelInstallError, tunnelReleaseFiles, type TunnelRelease } from "./tunnel-release.js";

const invalid = () => new TunnelInstallError("archive_invalid", "Release archive failed verification. Retry or contact the Foundry integration maintainer.");
const crcTable = Uint32Array.from({ length: 256 }, (_value, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); return value >>> 0; });
export function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!; return (crc ^ 0xffffffff) >>> 0; }
export const tunnelDigest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
/** Strict classic ZIP decoder for seven reviewed root-level regular files.
 * No ZIP64, encrypted members, links, directories, duplicate/alias paths, or
 * caller-selected output paths. Every inflated member has a hard output bound.
 */
export function unpackTunnelRelease(bytes: Buffer, release: TunnelRelease): Map<string, Buffer> {
  if (bytes.length !== release.bytes || bytes.length > 32 * 1024 * 1024 || tunnelDigest(bytes) !== release.sha256) throw new TunnelInstallError("integrity", "Official release checksum mismatch. Installation refused; existing tool retained.");
  try {
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== 7 || bytes.readUInt16LE(end + 10) !== 7) throw invalid();
    const centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
    if (centralStart + centralSize !== end) throw invalid();
    const allowed = new Set(tunnelReleaseFiles(release)), files = new Map<string, Buffer>(); let cursor = centralStart, total = 0;
    const spans: { start: number; end: number }[] = [];
    for (let member = 0; member < 7; member++) {
      if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
      const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), disk = bytes.readUInt16LE(cursor + 34), attributes = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString("utf8");
      const fileType = (attributes >>> 16) & 0o170000;
      // Bits 1-2 are DEFLATE compression-level hints (the official ZIP uses 2).
      // They confer no encryption or path authority and are invalid for stored data.
      if (cursor + 46 + nameLength + extra + comment > end || disk || (flags & ~0x80e) || (method !== 8 && (flags & 6)) || ![0, 8].includes(method) || !allowed.has(name) || files.has(name) || Buffer.from(name, "utf8").compare(nameBytes) || ![0, 0o100000].includes(fileType) || (attributes & 0x10) || size > 96 * 1024 * 1024 || compressed > 32 * 1024 * 1024 || local >= centralStart) throw invalid();
      total += size; if (total > 192 * 1024 * 1024) throw invalid();
      if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameLength) throw invalid();
      const localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + nameLength + localExtra, finish = start + compressed;
      if (finish > centralStart || bytes.subarray(local + 30, local + 30 + nameLength).compare(nameBytes)) throw invalid();
      if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) throw invalid();
      const payload = bytes.subarray(start, finish), inflated = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: Math.max(1, size) });
      if (inflated.length !== size || crc32(inflated) !== crc) throw invalid();
      spans.push({ start: local, end: finish }); files.set(name, inflated); cursor += 46 + nameLength + extra + comment;
    }
    spans.sort((a, b) => a.start - b.start);
    if (cursor !== end || spans.some((span, index) => index > 0 && span.start < spans[index - 1]!.end)) throw invalid();
    verifyTunnelFiles(files, release); return files;
  } catch (error) { if (error instanceof TunnelInstallError) throw error; throw invalid(); }
}
export function verifyTunnelFiles(files: Map<string, Buffer>, release: TunnelRelease): void {
  const expected = tunnelReleaseFiles(release), sbomName = `${release.archive.slice(0, -4)}.spdx.json`, sbomBytes = files.get(sbomName);
  if (files.size !== 7 || expected.some(name => !files.has(name)) || !sbomBytes || sbomBytes.length > 1024 * 1024 || tunnelDigest(sbomBytes) !== release.sbomSha256) throw invalid();
  const document = JSON.parse(sbomBytes.toString("utf8")) as { spdxVersion?: string; name?: string; files?: { fileName: string; checksums: { algorithm: string; checksumValue: string }[] }[] };
  if (document.spdxVersion !== "SPDX-2.3" || document.name !== "tunnel-client" || !Array.isArray(document.files) || document.files.length !== 6) throw invalid();
  const seen = new Set<string>();
  for (const entry of document.files) {
    const name = entry.fileName?.replace(/^\.\//, ""), checks = entry.checksums?.filter(check => check.algorithm === "SHA256");
    if (!name || name === sbomName || seen.has(name) || !files.has(name) || checks?.length !== 1 || tunnelDigest(files.get(name)!) !== checks[0]!.checksumValue) throw invalid(); seen.add(name);
  }
  // Basic Windows executable shape; verification never executes downloaded code.
  for (const name of ["tunnel-client.exe", "cloudflared.exe"]) { const file = files.get(name)!; if (file.length < 64 || file.toString("ascii", 0, 2) !== "MZ") throw invalid(); }
}
