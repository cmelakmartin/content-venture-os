import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export async function extractProduct(uploadDir, product) {
  const file = path.join(uploadDir, product.storedName);
  const extension = path.extname(product.storedName).toLowerCase();
  let text;
  if ([".txt", ".md"].includes(extension)) text = await fs.readFile(file, "utf8");
  else if (extension === ".docx") text = (await mammoth.extractRawText({ path: file })).value;
  else if (extension === ".pdf") {
    const parser = new PDFParse({ data: await fs.readFile(file) });
    try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
  } else throw new Error("ZIP packages are stored but cannot yet be analyzed automatically. Upload the primary PDF, DOCX, TXT or Markdown file.");
  const clean = text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  if (clean.length < 40) throw new Error("The product contains too little extractable text for analysis.");
  return { text: clean.slice(0, 120_000), characters: clean.length, truncated: clean.length > 120_000 };
}
