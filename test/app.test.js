import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { createApp } from "../lib/app.js";
import { memoryStore } from "../lib/memory-store.js";

const config = {
  consumerKey: "consumer",
  consumerSecret: "consumer-secret",
  clientId: "salesforce",
  clientPassword: "client-secret",
  jwtSecret: "a-long-enough-secret-for-hs256-signing",
  missing: [],
};
const BASE = "https://docrepo.test";

function setup(options = {}) {
  return createApp({ store: memoryStore(), config, ...options });
}

function clientHeader(overrides = {}) {
  return {
    client_id: config.clientId,
    client_password: config.clientPassword,
    end_user_id: "tester@example.com",
    request_time_stamp: "2026-10-21T15:04:05.123Z",
    unique_request_id: "b6f1e7d2-4c0a-4f43-9d1e-2a7c5e9b9a1c",
    ...overrides,
  };
}

async function getToken(app, nonce = "n1") {
  const response = await app(new Request(`${BASE}/auth/oauth/v2/token/generate?grant_type=client_credentials&nonce=${nonce}`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64")}` },
  }));
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

async function call(app, path, body, { nonce = "n1", tokenNonce = nonce } = {}) {
  const jwt = await getToken(app, tokenNonce);
  return app(new Request(`${BASE}${path}?nonce=${nonce}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function addBody(bytes, name = "Application form.pdf", header = clientHeader()) {
  return {
    client_header: header,
    doc_class: "Client_Document",
    property_list: [{ name: "DocType", values: "Application" }],
    content_info_list: [{ content_name: name, content_bytes: bytes.toString("base64") }],
  };
}

describe("token", () => {
  it("rejects a wrong consumer secret", async () => {
    const app = setup();
    const response = await app(new Request(`${BASE}/auth/oauth/v2/token/generate?grant_type=client_credentials&nonce=x`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("consumer:wrong").toString("base64")}` },
    }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error_code, "INVALID_CONSUMER");
  });

  it("requires a nonce", async () => {
    const app = setup();
    const response = await app(new Request(`${BASE}/auth/oauth/v2/token/generate?grant_type=client_credentials`, { method: "POST" }));
    assert.equal((await response.json()).error_code, "NONCE_REQUIRED");
  });

  it("refuses to run without configuration", async () => {
    const app = createApp({ store: memoryStore(), config: { missing: ["JWT_SECRET"] } });
    const response = await app(new Request(`${BASE}/auth/oauth/v2/token/generate?grant_type=client_credentials&nonce=x`, { method: "POST" }));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error_code, "NOT_CONFIGURED");
  });
});

describe("add document", () => {
  it("stores the content and returns a FileNet-style document ID", async () => {
    const app = setup();
    const bytes = randomBytes(5000);
    const response = await call(app, "/v1/document/add", addBody(bytes));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.document_id, /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
    assert.equal(result.content_size, 5000);
    assert.equal(result.diagnostics.content_base64_length, bytes.toString("base64").length);
  });

  it("rejects a JWT issued for a different nonce", async () => {
    const app = setup();
    const response = await call(app, "/v1/document/add", addBody(randomBytes(10)), { nonce: "n2", tokenNonce: "n1" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error_code, "NONCE_MISMATCH");
  });

  it("rejects wrong client credentials", async () => {
    const app = setup();
    const response = await call(app, "/v1/document/add", addBody(randomBytes(10), "a.pdf", clientHeader({ client_password: "nope" })));
    assert.equal(response.status, 403);
  });

  it("rejects a bad timestamp", async () => {
    const app = setup();
    const response = await call(app, "/v1/document/add", addBody(randomBytes(10), "a.pdf", clientHeader({ request_time_stamp: "2026-10-21 15:04" })));
    assert.equal((await response.json()).error_code, "INVALID_TIMESTAMP");
  });

  it("rejects content that isn't base64", async () => {
    const app = setup();
    const body = addBody(randomBytes(10));
    body.content_info_list[0].content_bytes = "not base64!";
    const response = await call(app, "/v1/document/add", body);
    assert.equal((await response.json()).error_code, "INVALID_CONTENT_BYTES");
  });

  it("enforces the content size limit", async () => {
    const app = setup({ maxContentBytes: 1000 });
    const response = await call(app, "/v1/document/add", addBody(randomBytes(1001)));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error_code, "CONTENT_TOO_LARGE");
  });
});

describe("get content", () => {
  it("returns what was stored", async () => {
    const app = setup();
    const bytes = randomBytes(12345);
    const added = await (await call(app, "/v1/document/add", addBody(bytes))).json();
    const response = await call(app, "/v2/document/getContent", {
      client_header: clientHeader(),
      content_request_info: { document_id: added.document_id, get_annotations: false, properties: ["DocType"] },
    });
    assert.equal(response.status, 200);
    const info = (await response.json()).document_info;
    assert.equal(info.document_id, added.document_id);
    assert.equal(info.total_pages, 1);
    assert.equal(info.content_info_list[0].mime_type, "application/pdf");
    assert.deepEqual(Buffer.from(info.content_info_list[0].content_bytes, "base64"), bytes);
    assert.deepEqual(info.property_list.map((p) => p.name), ["ContentSize", "DocType"]);
  });

  it("returns 404 for an unknown document", async () => {
    const app = setup();
    const response = await call(app, "/v2/document/getContent", {
      client_header: clientHeader(),
      content_request_info: { document_id: "{00000000-0000-0000-0000-000000000000}" },
    });
    assert.equal(response.status, 404);
  });

  it("generates a synthetic PDF of the exact size requested", async () => {
    const app = setup();
    for (const size of [1024, 99999, 3 * 1024 * 1024 + 7]) {
      const response = await call(app, "/v2/document/getContent", {
        client_header: clientHeader(),
        content_request_info: { document_id: `{SYNTHETIC-${size}-AB12}` },
      });
      const bytes = Buffer.from((await response.json()).document_info.content_info_list[0].content_bytes, "base64");
      assert.equal(bytes.length, size);
      assert.equal(bytes.subarray(0, 8).toString(), "%PDF-1.4");
      assert.match(bytes.subarray(-6).toString(), /%%EOF\n$/);
    }
  });
});

describe("direct upload", () => {
  function directSetup(options = {}) {
    const store = memoryStore();
    return { store, app: createApp({ store, config, ...options }) };
  }

  // What the client PUTs: the Add document body without its client_header.
  function uploadBody(bytes) {
    const { client_header: _, ...rest } = addBody(bytes);
    return JSON.stringify(rest);
  }

  async function uploadLink(app) {
    const response = await call(app, "/v1/document/uploadUrl", { client_header: clientHeader() });
    assert.equal(response.status, 200);
    return response.json();
  }

  it("stores a file that was sent straight to storage", async () => {
    const { store, app } = directSetup();
    const target = await uploadLink(app);
    assert.equal(target.upload_method, "PUT");
    const bytes = randomBytes(20000);
    store.receiveUpload(target.upload_id, uploadBody(bytes));

    const response = await call(app, "/v1/document/commit", { client_header: clientHeader(), upload_id: target.upload_id });
    assert.equal(response.status, 200);
    const added = await response.json();
    assert.equal(added.content_size, 20000);
    assert.equal(added.diagnostics.upload_id, target.upload_id);
    assert.equal(store.hasUpload(target.upload_id), false);

    const got = await call(app, "/v2/document/getContent", {
      client_header: clientHeader(),
      content_request_info: { document_id: added.document_id },
    });
    const info = (await got.json()).document_info;
    assert.deepEqual(Buffer.from(info.content_info_list[0].content_bytes, "base64"), bytes);
  });

  it("applies FileNet's size limit when the upload is committed", async () => {
    const { store, app } = directSetup({ maxContentBytes: 1000 });
    const target = await uploadLink(app);
    store.receiveUpload(target.upload_id, uploadBody(randomBytes(1001)));
    const response = await call(app, "/v1/document/commit", { client_header: clientHeader(), upload_id: target.upload_id });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error_code, "CONTENT_TOO_LARGE");
    assert.equal(store.hasUpload(target.upload_id), false);
  });

  it("reports a commit with nothing uploaded", async () => {
    const { app } = directSetup();
    const response = await call(app, "/v1/document/commit", { client_header: clientHeader(), upload_id: "MISSING" });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error_code, "UPLOAD_NOT_FOUND");
  });

  it("needs valid client credentials for an upload link", async () => {
    const { app } = directSetup();
    const response = await call(app, "/v1/document/uploadUrl", { client_header: clientHeader({ client_password: "nope" }) });
    assert.equal(response.status, 403);
  });
});

describe("status page", () => {
  it("lists recent documents", async () => {
    const app = setup();
    const added = await (await call(app, "/v1/document/add", addBody(randomBytes(10)))).json();
    const response = await app(new Request(`${BASE}/`));
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(added.document_id.slice(1, 9)));
  });
});
