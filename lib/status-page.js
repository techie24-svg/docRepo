const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

const ENDPOINTS = [
  ["POST", "/auth/oauth/v2/token/generate?grant_type=client_credentials&nonce=N", "Basic consumer key and secret. Returns a JWT for nonce N."],
  ["POST", "/v1/document/add?nonce=N", "Bearer JWT. Stores content_info_list and returns document_id. Limited to 4.5 MB by Vercel."],
  ["POST", "/v1/document/uploadUrl?nonce=N", "Bearer JWT. Direct upload, step 1: returns a one-time URL and headers for sending the Add document body straight to storage."],
  ["PUT", "upload_url from step 1", "Direct upload, step 2: the Add document body without client_header. Goes to Vercel Blob, not this function."],
  ["POST", "/v1/document/commit?nonce=N", "Bearer JWT. Direct upload, step 3: checks the uploaded body as Add document would and returns document_id."],
  ["POST", "/v2/document/getContent?nonce=N", "Bearer JWT. Returns content_info_list with base64 content, streamed."],
];

export function statusPage({ missing, recent, storeError }) {
  const rows = recent.map((doc) =>
    `<tr><td><code>${escape(doc.document_id)}</code></td><td>${mb(doc.size)} MB</td><td>${escape(new Date(doc.uploaded_at).toISOString())}</td></tr>`,
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mock FileNet CM REST API</title>
<style>
  body { font: 15px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2a37; max-width: 920px; margin: 32px auto; padding: 0 20px; }
  h1 { color: #0b2e59; font-size: 24px; margin-bottom: 4px; }
  h2 { color: #1f4e79; font-size: 17px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #d8e0ea; vertical-align: top; }
  th { background: #f4f7fa; }
  code { font-size: 13px; }
  .bad { color: #8c2f2f; font-weight: 600; }
  .ok { color: #146b45; font-weight: 600; }
</style>
</head>
<body>
<h1>Mock FileNet CM REST API</h1>
<p>A test stand-in for Guardian's FileNet CM REST APIs, for uploads from Salesforce. Use test files only.</p>
<p>Configuration: ${missing.length
    ? `<span class="bad">missing ${escape(missing.join(", "))}</span>`
    : '<span class="ok">ready</span>'}</p>

<h2>Endpoints</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Behaviour</th></tr>
${ENDPOINTS.map(([method, path, note]) => `<tr><td>${method}</td><td><code>${escape(path)}</code></td><td>${escape(note)}</td></tr>`).join("")}
</table>
<p>Every document call needs a <code>client_header</code> with client_id, client_password, end_user_id, request_time_stamp and unique_request_id.</p>

<h2>Limits</h2>
<table>
<tr><th>Limit</th><th>Value</th></tr>
<tr><td>Vercel request body</td><td>4.5 MB, so about a 3.2 MB file once base64-encoded, for calls to this function. Larger requests get 413 FUNCTION_PAYLOAD_TOO_LARGE from Vercel. Direct uploads avoid it.</td></tr>
<tr><td>FileNet content per document</td><td>20 MB, enforced on Add document and on commit with 413 CONTENT_TOO_LARGE</td></tr>
<tr><td>Get content response</td><td>Streamed, so Vercel's 4.5 MB response limit doesn't apply. Up to 15 pages per call.</td></tr>
<tr><td>Synthetic documents</td><td><code>{SYNTHETIC-&lt;bytes&gt;}</code> returns a generated PDF of that size, 1 KB to 50 MB, for view tests.</td></tr>
</table>

<h2>Recent documents</h2>
${storeError
    ? `<p class="bad">The Blob store could not be read: ${escape(storeError)}</p>`
    : rows
      ? `<table><tr><th>Document ID</th><th>Size</th><th>Received (UTC)</th></tr>${rows}</table>`
      : "<p>No documents yet.</p>"}
</body>
</html>`;
}
