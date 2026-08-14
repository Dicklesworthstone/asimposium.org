/**
 * The digest primitive is checked against published FIPS 180-4 vectors, not against itself.
 * Every other gate in this package trusts these values, so they are the one thing here that must
 * not be self-referential.
 */

import { describe, expect, test } from "bun:test";
import { bytesToHex, sha256Bytes, sha256Hex, utf8Bytes } from "../src/sha256.ts";

describe("sha256Hex against published vectors", () => {
  test("empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test('"abc"', () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("448-bit message, which forces a second compression block", () => {
    const message = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    expect(message.length).toBe(56);
    expect(sha256Hex(message)).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("utf8 encoding", () => {
  test("ascii is one byte per character", () => {
    expect(utf8Bytes("abc")).toEqual([0x61, 0x62, 0x63]);
  });

  test("two-byte and four-byte code points", () => {
    expect(utf8Bytes("é")).toEqual([0xc3, 0xa9]);
    expect(utf8Bytes("😀")).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  test("a surrogate pair encodes once, not twice", () => {
    expect(utf8Bytes("😀").length).toBe(4);
  });
});

describe("digest shape and behaviour", () => {
  test("lowercase hex, 64 characters", () => {
    expect(sha256Hex("asimposium")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same input, same digest; one changed byte, different digest", () => {
    expect(sha256Hex("promote, do not spray")).toBe(sha256Hex("promote, do not spray"));
    expect(sha256Hex("promote, do not spray")).not.toBe(sha256Hex("promote, do not spray."));
  });

  test("raw byte digest agrees with the hex helper", () => {
    expect(bytesToHex(sha256Bytes(utf8Bytes("abc")))).toBe(sha256Hex("abc"));
    expect(sha256Bytes(utf8Bytes("abc")).length).toBe(32);
  });

  test("input longer than one block still hashes deterministically", () => {
    const long = "falsifier ".repeat(500);
    expect(long.length).toBeGreaterThan(64);
    expect(sha256Hex(long)).toBe(sha256Hex(long));
    expect(sha256Hex(long)).toMatch(/^[0-9a-f]{64}$/);
  });
});
