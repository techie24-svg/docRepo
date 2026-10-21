import { ApiError } from "./errors.js";

// Test-only document IDs such as {SYNTHETIC-5242880} or {SYNTHETIC-5242880-1A2B}
// return a generated PDF of exactly that many bytes, so the view path can be
// tested with files larger than an upload through Vercel allows.
export const SYNTHETIC_ID = /^\{SYNTHETIC-(\d+)(?:-[0-9A-F]{1,16})?\}$/i;

const MIN_BYTES = 1024;
const MAX_BYTES = 50 * 1024 * 1024;
const CHUNK = 64 * 1024;

export function syntheticDocument(documentId) {
  const size = Number(SYNTHETIC_ID.exec(documentId)[1]);
  if (!Number.isSafeInteger(size) || size < MIN_BYTES || size > MAX_BYTES) {
    throw new ApiError(400, "INVALID_SYNTHETIC_SIZE", `Synthetic documents must be ${MIN_BYTES} to ${MAX_BYTES} bytes`);
  }
  return {
    document_id: documentId,
    doc_class: "Synthetic",
    property_list: [],
    contents: [{ content_name: `synthetic-${size}.pdf`, mime_type: "application/pdf", size, page_number: 1 }],
    open: () => pdfOfSize(size),
  };
}

function pdfParts(size) {
  const label = `(Synthetic test document: ${size} bytes) Tj`;
  const text = `BT /F1 18 Tf 72 720 Td ${label} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let head = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(head.length);
    head += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  offsets.push(head.length);

  // Object 6 is an unreferenced stream of padding; its length makes the total exact.
  const tail = (padding) => {
    const xrefAt = head.length + `6 0 obj\n<< /Length ${padding} >>\nstream\n`.length + padding + "\nendstream\nendobj\n".length;
    const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    return `\nendstream\nendobj\nxref\n0 7\n0000000000 65535 f \n${rows}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  };
  let padding = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const fixed = head.length + `6 0 obj\n<< /Length ${padding} >>\nstream\n`.length + tail(padding).length;
    padding = size - fixed;
  }
  if (padding < 0) {
    throw new ApiError(400, "INVALID_SYNTHETIC_SIZE", `Synthetic documents must be at least ${MIN_BYTES} bytes`);
  }
  return { start: `${head}6 0 obj\n<< /Length ${padding} >>\nstream\n`, padding, end: tail(padding) };
}

async function* pdfOfSize(size) {
  const { start, padding, end } = pdfParts(size);
  yield Buffer.from(start, "latin1");
  const block = Buffer.alloc(CHUNK, "0123456789abcdef");
  for (let left = padding; left > 0; left -= CHUNK) {
    yield left >= CHUNK ? block : block.subarray(0, left);
  }
  yield Buffer.from(end, "latin1");
}
