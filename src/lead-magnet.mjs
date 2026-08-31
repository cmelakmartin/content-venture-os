import crypto from "node:crypto";

function signingSecret() {
  const value = process.env.DELIVERY_SIGNING_SECRET || process.env.AUTH_SECRET;
  if (!value || value.length < 24) throw new Error("A 24+ character DELIVERY_SIGNING_SECRET or AUTH_SECRET is required for lead-magnet links.");
  return value;
}

export function createLeadMagnetToken(leadId, slug, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ leadId, slug, exp: new Date(expiresAt).getTime(), nonce: crypto.randomBytes(12).toString("base64url") })).toString("base64url");
  const signature = crypto.createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyLeadMagnetToken(token, expectedSlug) {
  const [payload, provided, extra] = String(token || "").split(".");
  if (!payload || !provided || extra) throw new Error("Invalid lead-magnet link.");
  const expected = crypto.createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  const left = Buffer.from(provided); const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error("Invalid lead-magnet link.");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!claims.leadId || claims.slug !== expectedSlug || Number(claims.exp) <= Date.now()) throw new Error("This lead-magnet link has expired.");
  return claims;
}

const SIGNS = [
  "Ideas are stored in several disconnected places.",
  "The team starts drafts without a clear audience or purpose.",
  "Research is repeated because sources are not retained.",
  "Approvals depend on one person remembering to respond.",
  "Writers regularly wait for missing context or examples.",
  "The same facts are manually copied between tools.",
  "A content calendar exists, but priorities change without a record.",
  "Drafts are rewritten because the brand voice is undocumented.",
  "SEO checks happen only after writing is complete.",
  "Repurposing is discussed but rarely scheduled.",
  "Published content has no named owner for measurement.",
  "Performance data is reviewed without a decision rule.",
  "Low-performing assets remain live without a test plan.",
  "High-performing assets are not turned into reusable patterns.",
  "Localization or personalization is entirely manual.",
  "AI output is used without a factual review step.",
  "Sensitive information can enter prompts without a policy.",
  "The team cannot explain which automation changed an asset.",
  "Content requests arrive through untracked messages.",
  "Workload grows faster than the publishing cadence.",
  "No one can state the single bottleneck to fix next."
];

function ascii(value) {
  return String(value || "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
}

function wrap(value, width = 78) {
  const words = ascii(value).split(/\s+/).filter(Boolean); const lines = []; let current = "";
  for (const word of words) {
    if (!current || `${current} ${word}`.length <= width) current = current ? `${current} ${word}` : word;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

function pdfEscape(value) {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function createLeadMagnetPdf(content = {}) {
  const title = content.leadMagnet || "Content Workflow Diagnostic";
  const lines = [title, "", content.subheadline || content.promise || "A practical self-assessment for your content operation.", "", "Check every statement that is true today:", ""];
  SIGNS.forEach((item, index) => lines.push(...wrap(`${index + 1}. [ ] ${item}`), ""));
  lines.push("", "NEXT STEP", "Choose the first checked item that creates repeated delay or risk. Assign one owner, define one observable success measure, and run a reversible two-week improvement before automating more.");
  const wrapped = lines.flatMap((line) => line === "" ? [""] : wrap(line));
  const pages = []; for (let index = 0; index < wrapped.length; index += 43) pages.push(wrapped.slice(index, index + 43));
  const fontId = 3 + pages.length * 2;
  const objects = [null, "<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  pages.forEach((page, index) => {
    const pageId = 3 + index * 2; const streamId = pageId + 1;
    const commands = ["BT", "/F1 11 Tf", "54 738 Td"];
    page.forEach((line, lineIndex) => { if (lineIndex) commands.push("0 -16 Td"); commands.push(`(${pdfEscape(line)}) Tj`); });
    commands.push("ET"); const stream = commands.join("\n");
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`;
    objects[streamId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let output = "%PDF-1.4\n"; const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) { offsets[id] = Buffer.byteLength(output); output += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}
