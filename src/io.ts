/**
 * I/O 具象クラスモジュール。
 *
 * zip.js の `Uint8ArrayReader` / `Uint8ArrayWriter` に対応する
 * 具象実装を提供する。ブラウザ・Node.js 両方で動作する。
 *
 * @module
 */

import type { Reader, Writer } from "./types.js";

// ---------------------------------------------------------------------------
// Uint8ArrayReader
// ---------------------------------------------------------------------------

/**
 * `Uint8Array` からの読み取りを提供する Reader。
 *
 * zip.js の `Uint8ArrayReader` に対応する。
 *
 * @example
 * ```ts
 * const reader = new Uint8ArrayReader(data);
 * const chunk = await reader.readUint8Array(0, 100);
 * ```
 */
export class Uint8ArrayReader implements Reader {
  private readonly data: Uint8Array;

  /**
   * @param data - 読み出し対象のバイト列
   */
  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** @inheritdoc */
  get size(): number {
    return this.data.length;
  }

  /** @inheritdoc */
  async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    return this.data.subarray(offset, offset + length);
  }
}

// ---------------------------------------------------------------------------
// Uint8ArrayWriter
// ---------------------------------------------------------------------------

/**
 * `Uint8Array` への書き込みを提供する Writer。
 *
 * zip.js の `Uint8ArrayWriter` に対応する。
 * 内部で動的にバッファを拡張する。
 *
 * @example
 * ```ts
 * const writer = new Uint8ArrayWriter();
 * await writer.writeUint8Array(chunk);
 * const result = await writer.getData();
 * ```
 */
export class Uint8ArrayWriter implements Writer<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private totalSize = 0;

  /** @inheritdoc */
  async writeUint8Array(array: Uint8Array): Promise<void> {
    this.chunks.push(array);
    this.totalSize += array.length;
  }

  /** @inheritdoc */
  async getData(): Promise<Uint8Array> {
    if (this.chunks.length === 1) {
      return this.chunks[0];
    }
    const result = new Uint8Array(this.totalSize);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
