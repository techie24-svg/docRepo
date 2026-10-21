// End-to-end check of a deployed mock: token, add, get content, Vercel's body limit,
// direct uploads past that limit, FileNet's 20 MB rule, and a streamed synthetic document
// larger than Vercel's response limit.
//
//   node scripts/smoke.mjs https://docpoc-virid.vercel.app
//
// Reads credentials from .secrets.env (or the environment) and never prints them.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node scripts/smoke.mjs <base-url>");
  process.exit(1);
}

const env = { ...process.env };
try {
  for (const line of readFileSync(new URL("../.secrets.env", import.meta.url), "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) {
      env[match[1]] ??= match[2];
    }
  }
} catch {
  // Fall back to the environment.
}

const MB = 1024 * 1024;
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) {
    failures++;
  }
}

function clientHeader() {
  return {
    client_id: env.CLIENT_ID,
    client_password: env.CLIENT_PASSWORD,
    end_user_id: "smoke-test",
    request_time_stamp: new Date().toISOString(),
    unique_request_id: crypto.randomUUID(),
  };
}

async function token(nonce) {
  const response = await fetch(`${base}/auth/oauth/v2/token/generate?grant_type=client_credentials&nonce=${nonce}`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${env.CONSUMER_KEY}:${env.CONSUMER_SECRET}`).toString("base64")}` },
  });
  return { status: response.status, body: await response.json() };
}

async function call(path, body) {
  const nonce = randomBytes(8).toString("hex");
  const { body: issued } = await token(nonce);
  const started = performance.now();
  const response = await fetch(`${base}${path}?nonce=${nonce}`, {
    method: "POST",
    headers: { authorization: `Bearer ${issued.access_token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, ms: Math.round(performance.now() - started) };
}

function addBody(bytes) {
  return {
    client_header: clientHeader(),
    doc_class: "Client_Document",
    property_list: [{ name: "DocType", values: "Smoke test" }],
    content_info_list: [{ content_name: "smoke.pdf", content_bytes: bytes.toString("base64") }],
  };
}

const status = await fetch(`${base}/`);
const page = await status.text();
check("status page is ready", status.status === 200 && page.includes(">ready<"), `HTTP ${status.status}`);

const issued = await token("smoke");
check("token is issued", issued.status === 200 && Boolean(issued.body.access_token), `HTTP ${issued.status}`);

const small = randomBytes(100 * 1024);
const added = await call("/v1/document/add", addBody(small));
const addedJson = added.status === 200 ? JSON.parse(added.text) : {};
check("add document stores 100 KB", added.status === 200 && /^\{[0-9A-F-]{36}\}$/.test(addedJson.document_id ?? ""), `HTTP ${added.status}, ${added.ms} ms`);

if (addedJson.document_id) {
  const got = await call("/v2/document/getContent", {
    client_header: clientHeader(),
    content_request_info: { document_id: addedJson.document_id, get_annotations: false },
  });
  const content = got.status === 200 ? JSON.parse(got.text).document_info.content_info_list[0].content_bytes : "";
  check("get content returns the same bytes", Buffer.from(content, "base64").equals(small), `HTTP ${got.status}, ${got.ms} ms`);
}

const fits = randomBytes(Math.floor(3.2 * MB));
const fitsResult = await call("/v1/document/add", addBody(fits));
check("a 3.2 MB file fits under Vercel's 4.5 MB body limit", fitsResult.status === 200, `HTTP ${fitsResult.status}, body ${(JSON.stringify(addBody(fits)).length / MB).toFixed(2)} MB`);

const tooBig = randomBytes(Math.floor(3.6 * MB));
const tooBigResult = await call("/v1/document/add", addBody(tooBig));
check("a 3.6 MB file gets Vercel's 413", tooBigResult.status === 413, `HTTP ${tooBigResult.status}: ${tooBigResult.text.replace(/\s+/g, " ").slice(0, 60)}`);

// Direct upload: link, PUT straight to storage, commit.
async function direct(bytes) {
  const link = await call("/v1/document/uploadUrl", { client_header: clientHeader() });
  if (link.status !== 200) {
    return { ...link, stage: "link" };
  }
  const target = JSON.parse(link.text);
  const { client_header: _, ...body } = addBody(bytes);
  const payload = JSON.stringify(body);
  const started = performance.now();
  const put = await fetch(target.upload_url, {
    method: "PUT",
    headers: { ...target.upload_headers, "content-type": "application/json" },
    body: payload,
  });
  const putMs = Math.round(performance.now() - started);
  if (!put.ok) {
    return { status: put.status, text: await put.text(), stage: "upload" };
  }
  const committed = await call("/v1/document/commit", { client_header: clientHeader(), upload_id: target.upload_id });
  return { ...committed, stage: "commit", bodyMb: payload.length / MB, putMs };
}

const big = randomBytes(12 * MB);
const bigResult = await direct(big);
const bigJson = bigResult.status === 200 ? JSON.parse(bigResult.text) : {};
check("direct upload stores a 12 MB file", bigResult.status === 200 && bigJson.content_size === big.length,
  `${bigResult.stage} HTTP ${bigResult.status}, body ${bigResult.bodyMb?.toFixed(2)} MB, upload ${bigResult.putMs} ms`);
if (bigJson.document_id) {
  const got = await call("/v2/document/getContent", {
    client_header: clientHeader(),
    content_request_info: { document_id: bigJson.document_id },
  });
  const content = got.status === 200 ? JSON.parse(got.text).document_info.content_info_list[0].content_bytes : "";
  check("get content returns the same 12 MB", Buffer.from(content, "base64").equals(big), `HTTP ${got.status}, ${got.ms} ms`);
}

const overLimit = await direct(randomBytes(21 * MB));
check("direct upload applies FileNet's 20 MB limit", overLimit.status === 413 && overLimit.text.includes("CONTENT_TOO_LARGE"),
  `${overLimit.stage} HTTP ${overLimit.status}`);

const synthetic = await call("/v2/document/getContent", {
  client_header: clientHeader(),
  content_request_info: { document_id: `{SYNTHETIC-${6 * MB}-5A0E}` },
});
const syntheticBytes = synthetic.status === 200
  ? Buffer.from(JSON.parse(synthetic.text).document_info.content_info_list[0].content_bytes, "base64").length
  : 0;
check("a 6 MB synthetic document streams past the 4.5 MB response limit", syntheticBytes === 6 * MB, `HTTP ${synthetic.status}, response ${(synthetic.text.length / MB).toFixed(2)} MB, ${synthetic.ms} ms`);

process.exit(failures ? 1 : 0);
