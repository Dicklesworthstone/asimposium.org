/** Locate the end of ONE RFC 1951 stream, without materializing its output.
 * Some gzip runtimes accept concatenated members. Inspecting only the first
 * gzip header would then miss metadata on later members, even empty ones.
 * This framing pass does not replace native decompression or CRC validation.
 * https://www.rfc-editor.org/rfc/rfc1951 (sections 3.2.2 through 3.2.7).
 */
const invalid = (): never => {
  throw new Error("ARTIFACT_ARCHIVE_INVALID");
};
const MAX_BLOCKS = 4096;
class Bits {
  private buffer = 0;
  private available = 0;
  private cursor: number;
  constructor(
    private readonly data: Uint8Array,
    start: number,
    private readonly limit: number,
  ) {
    this.cursor = start;
  }
  peek(count: number): number {
    while (this.available < count && this.cursor < this.limit) {
      this.buffer |= this.data[this.cursor++]! << this.available;
      this.available += 8;
    }
    return this.buffer & ((1 << count) - 1);
  }
  read(count: number): number {
    const result = this.peek(count);
    if (this.available < count) return invalid();
    this.buffer >>>= count;
    this.available -= count;
    return result;
  }
  align(): void {
    this.read(this.available % 8);
  }
  position(): number {
    return this.cursor - this.available / 8;
  }
  skipBytes(count: number): void {
    this.align();
    const end = this.position() + count;
    if (end > this.limit) invalid();
    this.cursor = end;
    this.buffer = 0;
    this.available = 0;
  }
}

class Huffman {
  private readonly table: Uint32Array = new Uint32Array(0);
  private readonly width: number = 0;
  constructor(lengths: readonly number[]) {
    const counts = new Uint16Array(16);
    for (const length of lengths) {
      if (length < 0 || length > 15 || !Number.isInteger(length)) invalid();
      if (length !== 0) counts[length] = counts[length]! + 1;
    }
    this.width = Math.max(...lengths);
    this.table = new Uint32Array(1 << this.width);
    const next = new Uint16Array(16);
    let code = 0;
    let left = 1;
    for (let width = 1; width <= 15; width++) {
      left = left * 2 - counts[width]!;
      if (left < 0) invalid();
      code = (code + counts[width - 1]!) * 2;
      next[width] = code;
    }
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      const length = lengths[symbol]!;
      if (length === 0) continue;
      let canonical = next[length]!;
      next[length] = canonical + 1;
      let reversed = 0;
      for (let bit = 0; bit < length; bit++) {
        reversed = (reversed << 1) | (canonical & 1);
        canonical >>>= 1;
      }
      for (let slot = reversed; slot < this.table.length; slot += 1 << length) {
        this.table[slot] = (length << 16) | symbol;
      }
    }
  }
  read(bits: Bits): number {
    const entry = this.table[bits.peek(this.width)] ?? 0;
    const length = entry >>> 16;
    if (length === 0) return invalid();
    bits.read(length);
    return entry & 0xffff;
  }
}

const FIXED_LITERAL = new Huffman(
  Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)),
);
const FIXED_DISTANCE = new Huffman(Array.from({ length: 32 }, () => 5));
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
] as const;
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const;
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
] as const;

function dynamicTrees(bits: Bits): readonly [Huffman, Huffman] {
  const literals = bits.read(5) + 257;
  const distances = bits.read(5) + 1;
  const codes = bits.read(4) + 4;
  if (literals > 286) return invalid();
  const lengths = Array<number>(19).fill(0);
  for (let i = 0; i < codes; i++) lengths[ORDER[i]!] = bits.read(3);
  const codeTree = new Huffman(lengths);
  const result: number[] = [];
  while (result.length < literals + distances) {
    const symbol = codeTree.read(bits);
    if (symbol < 16) {
      result.push(symbol);
      continue;
    }
    if (symbol > 18 || (symbol === 16 && result.length === 0)) return invalid();
    const value = symbol === 16 ? result.at(-1)! : 0;
    const repetitions =
      symbol === 16 ? bits.read(2) + 3 : symbol === 17 ? bits.read(3) + 3 : bits.read(7) + 11;
    if (result.length + repetitions > literals + distances) return invalid();
    for (let i = 0; i < repetitions; i++) result.push(value);
  }
  if (result[256] === 0) return invalid();
  return [new Huffman(result.slice(0, literals)), new Huffman(result.slice(literals))];
}

export function deflateMemberEnd(
  bytes: Uint8Array,
  start: number,
  limit: number,
  outputCap: number,
): { end: number; expanded: number } {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(limit) ||
    !Number.isSafeInteger(outputCap) ||
    start < 0 ||
    start >= limit ||
    limit > bytes.length ||
    outputCap < 0 ||
    outputCap > 64 * 1024 * 1024
  )
    return invalid();
  const bits = new Bits(bytes, start, limit);
  let final = 0;
  let blocks = 0;
  let expanded = 0;
  do {
    if (++blocks > MAX_BLOCKS) return invalid();
    final = bits.read(1);
    const kind = bits.read(2);
    if (kind === 3) return invalid();
    if (kind === 0) {
      bits.align();
      const length = bits.read(16);
      if ((length ^ bits.read(16)) !== 65535) return invalid();
      bits.skipBytes(length);
      expanded += length;
    } else {
      const [literal, distance] = kind === 1 ? [FIXED_LITERAL, FIXED_DISTANCE] : dynamicTrees(bits);
      for (;;) {
        const symbol = literal.read(bits);
        if (symbol === 256) break;
        if (symbol < 256) expanded++;
        else {
          const index = symbol - 257;
          if (index < 0 || index >= LENGTH_BASE.length) return invalid();
          const length = LENGTH_BASE[index]! + bits.read(LENGTH_EXTRA[index]!);
          const distCode = distance.read(bits);
          if (distCode >= DISTANCE_BASE.length) return invalid();
          const extra = distCode < 4 ? 0 : (distCode >>> 1) - 1;
          const backward = DISTANCE_BASE[distCode]! + bits.read(extra);
          if (backward > expanded) return invalid();
          expanded += length;
        }
        if (expanded > outputCap) return invalid();
      }
    }
    if (expanded > outputCap) return invalid();
  } while (final === 0);
  bits.align();
  return { end: bits.position(), expanded };
}
