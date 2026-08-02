/**
 * ファイル名の文字コードと長いファイル名 (LFN) の照合。
 *
 * 検証する 3 点:
 *
 * 1. **CP932 のファイル名** — 日本語圏の書庫はほぼこれ。ライブラリ自身は
 *    文字コードを推測せず、`filenameDecoder` の注入に委ねる設計なので、
 *    注入したデコーダーが正しく効くことを確認する。
 * 2. **長いファイル名** — Windows 95 以降の実装は拡張ヘッダー 0x01 に
 *    長い名前を格納する。MS-DOS 期の 8.3 (`PROGRA~1`) は当時の仕様どおり
 *    なので追随しないが、0x01 は読めなければならない。
 * 3. **ディレクトリ + 日本語** — 拡張ヘッダー 0x02 の区切りは 0xFF である。
 *    デコードしてから 0xFF を置換する順序だと、0xFF を表現できない CP932 では
 *    区切りが失われる。バイト列のまま分割していることを確認する。
 *
 * 期待値は `tools/gen-filename-fixtures.py` が、生成した書庫のヘッダーから
 * 実際の格納バイト列を読み出して作る。「こう作ったはず」という思い込みでは
 * なく、書庫に本当に入っている名前を正としている。
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { LhaReader } from "../src/reader.js";
import { Uint8ArrayReader, Uint8ArrayWriter } from "../src/io.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "fixtures", "filenames");
const MANIFEST = path.join(DIR, "expected.json");
const available = fs.existsSync(MANIFEST);

interface EntryExpectation {
  size: number;
  sha256: string;
  matchedInput: boolean;
  headerLevel: number;
}

interface ArchiveExpectation {
  headerLevel: number;
  case: string;
  encoding: string;
  entries: Record<string, EntryExpectation>;
}

const manifest: Record<string, ArchiveExpectation> = available
  ? JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
  : {};

/**
 * CP932 デコーダー。
 *
 * Node にも主要ブラウザにも `TextDecoder("shift_jis")` があり、これは
 * 実質 CP932 として動く。利用側がこういう関数を 1 つ渡すだけで日本語の
 * 書庫が読める、というのがこのライブラリの想定する使い方である。
 */
const cp932 = (bytes: Uint8Array): string =>
  new TextDecoder("shift_jis").decode(bytes);

describe.skipIf(!available)("ファイル名の文字コードと LFN", () => {
  const archives = Object.keys(manifest).sort();

  it("フィクスチャが 3 種類の観点をすべて含む", () => {
    const cases = new Set(archives.map((a) => manifest[a].case));
    expect(cases).toEqual(new Set(["sjis", "lfn", "dirs"]));
  });

  for (const archive of archives) {
    const meta = manifest[archive];

    describe(`${archive} (${meta.case}, level ${meta.headerLevel})`, () => {
      it("ファイル名を正しくデコードできる", async () => {
        const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, archive)));
        const reader = new LhaReader(new Uint8ArrayReader(bytes), {
          filenameDecoder: cp932,
        });
        try {
          const entries = await reader.getEntries();
          expect(entries.map((e) => e.filename).sort()).toEqual(
            Object.keys(meta.entries).sort()
          );
        } finally {
          await reader.close();
        }
      });

      it("各エントリの内容が壊れていない", async () => {
        const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, archive)));
        const reader = new LhaReader(new Uint8ArrayReader(bytes), {
          filenameDecoder: cp932,
        });
        try {
          for (const entry of await reader.getEntries()) {
            const want = meta.entries[entry.filename];
            expect(want, `未知のエントリ: ${entry.filename}`).toBeDefined();
            const data = await entry.getData(new Uint8ArrayWriter());
            expect(data.length, `${entry.filename} の長さ`).toBe(want.size);
            expect(
              crypto.createHash("sha256").update(data).digest("hex"),
              `${entry.filename} の内容`
            ).toBe(want.sha256);
          }
        } finally {
          await reader.close();
        }
      });
    });
  }

  it("ディレクトリ区切りが 0xFF のまま残らない", async () => {
    // 0xFF をデコード後に置換する実装だと、CP932 では U+FFFD に潰れて
    // 区切りが失われる。区切り文字が生き残っていることを直接確かめる。
    for (const archive of archives.filter((a) => manifest[a].case === "dirs")) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, archive)));
      const reader = new LhaReader(new Uint8ArrayReader(bytes), {
        filenameDecoder: cp932,
      });
      const names = (await reader.getEntries()).map((e) => e.filename);
      await reader.close();

      for (const name of names) {
        expect(name, `${archive}: 置換に失敗した区切りが残っている`).not.toContain("�");
        expect(name, `${archive}: 0xFF が素通ししている`).not.toContain("ÿ");
        expect(name, `${archive}: ディレクトリ区切りが失われている`).toContain("/");
      }
    }
  });

  it("8.3 に収まらない長いファイル名を保持できる", async () => {
    for (const archive of archives.filter((a) => manifest[a].case === "lfn")) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, archive)));
      const reader = new LhaReader(new Uint8ArrayReader(bytes), {
        filenameDecoder: cp932,
      });
      const names = (await reader.getEntries()).map((e) => e.filename);
      await reader.close();

      // 8.3 に切り詰められていないこと
      expect(names.some((n) => n.length > 100), `${archive}`).toBe(true);
      expect(names.some((n) => n.includes("~")), `${archive}: 8.3 に丸められている`).toBe(false);
    }
  });
});
