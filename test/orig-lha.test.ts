/**
 * オリジナル LHA (MS-DOS, 吉崎栄泰, 1992) が実際に吐いたバイト列との照合。
 *
 * 期待値はアーカイブに入れた原本そのものの sha256 であり、lhats の出力を
 * 期待値にしてはいない。フィクスチャは `tools/gen-orig-lha-fixtures.sh` が
 * 生成する。再配布条件の都合で LHA.exe はコミットしないため、
 * フィクスチャが無い環境ではスキップする。
 *
 *   LHA_DOS_DIR=~/.cache/nekoloaf/lha-dos ./tools/gen-orig-lha-fixtures.sh
 *   pnpm test
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { LhaReader } from "../src/reader.js";
import { Uint8ArrayReader, Uint8ArrayWriter } from "../src/io.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "fixtures", "orig");
const MANIFEST = path.join(DIR, "expected.json");
const available = fs.existsSync(MANIFEST);

interface Expectation {
  size: number;
  sha256: string;
}

const expected: Record<string, Expectation> = available
  ? JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
  : {};

describe.skipIf(!available)("オリジナル LHA 2.55 (1992) との照合", () => {
  const archives = available
    ? fs.readdirSync(DIR).filter((n) => n.endsWith(".LZH")).sort()
    : [];

  it("フィクスチャが存在する", () => {
    expect(archives.length).toBeGreaterThan(0);
    // -lh1- が corpus に含まれていなければ、この照合の主目的が果たせない
    expect(archives).toContain("O_H0.LZH");
  });

  for (const name of archives) {
    it(name, async () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, name)));
      const reader = new LhaReader(new Uint8ArrayReader(bytes));
      try {
        const entries = await reader.getEntries();
        expect(entries.map((e) => e.filename.toUpperCase()).sort()).toEqual(
          Object.keys(expected).sort()
        );

        for (const entry of entries) {
          const want = expected[entry.filename.toUpperCase()];
          const data = await entry.getData(new Uint8ArrayWriter());
          const got = crypto.createHash("sha256").update(data).digest("hex");
          const where = `${entry.filename} (${entry.method})`;
          // 長さを先に見ると、ずれたときの切り分けが早い
          expect(data.length, `${where} の長さ`).toBe(want.size);
          expect(got, `${where} の内容`).toBe(want.sha256);
        }
      } finally {
        await reader.close();
      }
    });
  }
});
