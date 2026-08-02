/**
 * 網羅フィクスチャ照合。
 *
 * `tools/gen-lzh-matrix.py` が生成した「圧縮方式 × ヘッダーレベル ×
 * ペイロード形状」の総当たり書庫に対し、lhats の展開結果が外部リーダー
 * (libarchive / lhasa) の結果と一致するかを検証する。
 *
 * corpus は 100 件超・数十 MB になるためリポジトリにはコミットしない。
 * 環境変数 `LZH_MATRIX_DIR` が指す場所に無ければテスト全体をスキップする。
 * 同梱フィクスチャ (`test/fixtures/`) だけでも主要な経路は押さえてあり、
 * こちらは「広く踏む」ための追加検証という位置づけ。
 *
 *   ./tools/build-lha-unix.sh
 *   python3 tools/gen-lzh-matrix.py --out /tmp/lhats-matrix
 *   LZH_MATRIX_DIR=/tmp/lhats-matrix pnpm test
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LhaReader } from "../src/reader.js";
import { Uint8ArrayReader, Uint8ArrayWriter } from "../src/io.js";

interface EntryExpectation {
  size: number;
  sha256: string;
  oracle: string;
}

interface ArchiveExpectation {
  requestedMethod: string;
  headerLevel: number;
  payloadSet: string;
  actualMethods: string[];
  entries: Record<string, EntryExpectation>;
}

const DIR = process.env.LZH_MATRIX_DIR ?? "";
const MANIFEST = DIR ? path.join(DIR, "manifest.json") : "";
const available = Boolean(DIR) && fs.existsSync(MANIFEST);

const manifest: Record<string, ArchiveExpectation> = available
  ? JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
  : {};

/** CP932 のファイル名も扱えるようにしておく。 */
const decodeName = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
};

describe.skipIf(!available)("網羅フィクスチャ照合", () => {
  const names = Object.keys(manifest).sort();

  it("corpus が空でない", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const archive of names) {
    const meta = manifest[archive];
    const methods = [...new Set(meta.actualMethods)].join(",");

    it(`${archive} [${methods}] level=${meta.headerLevel}`, async () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, archive)));
      const reader = new LhaReader(new Uint8ArrayReader(bytes), {
        filenameDecoder: decodeName,
      });
      try {
        const entries = await reader.getEntries();
        for (const [name, want] of Object.entries(meta.entries)) {
          const entry = entries.find((e) => e.filename === name);
          expect(entry, `エントリが見つからない: ${name}`).toBeDefined();

          const data = await entry!.getData(new Uint8ArrayWriter());
          expect(data.length, `${name} の長さ`).toBe(want.size);
          expect(
            crypto.createHash("sha256").update(data).digest("hex"),
            `${name} の内容 (期待値の出所: ${want.oracle})`
          ).toBe(want.sha256);
        }
      } finally {
        await reader.close();
      }
    });
  }
});
