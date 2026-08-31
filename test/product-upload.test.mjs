import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProductUploadStore } from "../src/product-upload.mjs";

test("product upload accepts ordered small chunks and preserves exact bytes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "venture-upload-"));
  const store = await createProductUploadStore(directory, { maxChunkBytes: 4 });
  const source = Buffer.from("exact-owner-product");
  const session = await store.start({ name: "Owner Guide.pdf", size: source.length });
  for (let offset = 0; offset < source.length; offset += 4) {
    const chunk = source.subarray(offset, offset + 4);
    await store.append(session.id, { offset, data: chunk.toString("base64") });
  }
  const product = await store.complete(session.id);
  assert.equal(product.originalName, "Owner Guide.pdf");
  assert.deepEqual(await fs.readFile(path.join(directory, "uploads", product.storedName)), source);
});

test("product upload rejects out-of-order chunks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "venture-upload-"));
  const store = await createProductUploadStore(directory);
  const session = await store.start({ name: "guide.pdf", size: 3 });
  await assert.rejects(() => store.append(session.id, { offset: 1, data: Buffer.from("abc").toString("base64") }), /offset mismatch/);
});
