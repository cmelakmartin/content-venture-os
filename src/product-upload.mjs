import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ALLOWED_EXTENSIONS = new Set(["pdf", "docx", "txt", "md"]);
const SAFE_ID = /^[a-f0-9-]{36}$/;

export async function createProductUploadStore(dataDir, options = {}) {
  const maxBytes = options.maxBytes || 8_000_000;
  const maxChunkBytes = options.maxChunkBytes || 512_000;
  const partsDir = path.join(dataDir, "upload-parts");
  const uploadsDir = path.join(dataDir, "uploads");
  await fs.mkdir(partsDir, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });

  const paths = (id) => {
    if (!SAFE_ID.test(String(id))) throw new Error("Invalid upload session.");
    return { metadata: path.join(partsDir, `${id}.json`), part: path.join(partsDir, `${id}.part`) };
  };
  const readSession = async (id) => JSON.parse(await fs.readFile(paths(id).metadata, "utf8"));
  const writeSession = async (session) => fs.writeFile(paths(session.id).metadata, JSON.stringify(session), { mode: 0o600 });

  return {
    async start(input) {
      const originalName = path.basename(String(input.name || ""));
      const extension = originalName.split(".").pop().toLowerCase();
      const expectedBytes = Number(input.size);
      if (!originalName || !ALLOWED_EXTENSIONS.has(extension)) throw new Error("Use a PDF, DOCX, TXT or Markdown file.");
      if (!Number.isInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) throw new Error("The upload must be between 1 byte and 8 MB.");
      const id = crypto.randomUUID();
      const session = { id, originalName, extension, expectedBytes, receivedBytes: 0, createdAt: new Date().toISOString() };
      await fs.writeFile(paths(id).part, Buffer.alloc(0), { mode: 0o600 });
      await writeSession(session);
      return session;
    },

    async append(id, input) {
      const session = await readSession(id);
      const offset = Number(input.offset);
      const encoded = String(input.data || "");
      if (!Number.isInteger(offset) || offset !== session.receivedBytes) throw new Error(`Upload offset mismatch. Expected ${session.receivedBytes}.`);
      if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid upload chunk.");
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length > maxChunkBytes) throw new Error("Upload chunk is too large.");
      if (session.receivedBytes + bytes.length > session.expectedBytes) throw new Error("Upload exceeds its declared size.");
      await fs.appendFile(paths(id).part, bytes);
      session.receivedBytes += bytes.length;
      await writeSession(session);
      return { id, receivedBytes: session.receivedBytes, expectedBytes: session.expectedBytes };
    },

    async complete(id) {
      const session = await readSession(id);
      const part = paths(id).part;
      const stat = await fs.stat(part);
      if (session.receivedBytes !== session.expectedBytes || stat.size !== session.expectedBytes) throw new Error(`Upload is incomplete (${session.receivedBytes} of ${session.expectedBytes} bytes).`);
      const storedName = `${session.id}.${session.extension}`;
      await fs.rename(part, path.join(uploadsDir, storedName));
      await fs.unlink(paths(id).metadata);
      return { id: session.id, originalName: session.originalName, storedName, bytes: session.expectedBytes, uploadedAt: new Date().toISOString() };
    }
  };
}
