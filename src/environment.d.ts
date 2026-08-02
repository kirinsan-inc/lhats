/**
 * 実行環境が備える標準 API の最小宣言。
 *
 * このライブラリは Node.js の型 (`@types/node`) にも `lib.dom` にも
 * 依存しない。`tsconfig.json` で `types: []` / `lib: ["ES2022"]` としている
 * のはそのためで、うっかり `Buffer` や `process` を使っても型が通らない
 * ようにしてある。
 *
 * その代わり、Node と主要ブラウザの双方が備えている WHATWG Encoding API の
 * デコーダーだけをここで最小限宣言する。この宣言はビルド成果物には出力されないため、
 * 利用側のグローバル型と衝突することはない。
 *
 * @module
 */

interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

interface TextDecoderLike {
  decode(input?: Uint8Array): string;
}

declare const TextDecoder: {
  new (label?: string, options?: TextDecoderOptions): TextDecoderLike;
};
