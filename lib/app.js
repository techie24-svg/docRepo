import { randomUUID } from "node:crypto";

import { basicCredentials, checkClientHeader, issueToken, sameSecret, verifyBearer } from "./auth.js";
import { base64Chunks } from "./base64-stream.js";
import { ApiError } from "./errors.js";
import { mimeTypeFor } from "./mime.js";
import { statusPage } from "./status-page.js";
import { SYNTHETIC_ID, syntheticDocument } from "./synthetic.js";

export const FILENET_MAX_CONTENT_BYTES = 20 * 1024 * 1024;
// Room for FileNet's 20 MB once base64-encoded, so commit's 20 MB check is the one that bites.
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const PAGES_PER_CALL = 15;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function createApp({ store, config, maxContentBytes = FILENET_MAX_CONTENT_BYTES }) {
  const routes = {
    token: { method: "POST", handle: (request, url) => token(request, url, config) },
    add: { method: "POST", handle: (request, url) => add(request, url, config, store, maxContentBytes) },
    uploadUrl: { method: "POST", handle: (request, url) => uploadUrl(request, url, config, store) },
    commit: { method: "POST", handle: (request, url) => commit(request, url, config, store, maxContentBytes) },
    getContent: { method: "POST", handle: (request, url) => getContent(request, url, config, store) },
    status: { method: "GET", handle: () => status(store, config) },
  };

  return async function fetch(request) {
    const url = new URL(request.url);
    try {
      const route = routes[routeOf(url)];
      if (!route) {
        throw new ApiError(404, "NOT_FOUND", `There is no endpoint at ${url.pathname}`);
      }
      if (request.method !== route.method) {
        throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${route.method}`);
      }
      return await route.handle(request, url);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

// Vercel rewrites the FileNet paths to /api?route=...; tests call the paths directly.
function routeOf(url) {
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/auth/oauth/v2/token/generate") {
    return "token";
  }
  const match = /^\/v[12]\/document\/(add|uploadUrl|commit|getContent)$/.exec(path);
  if (match) {
    return match[1];
  }
  if (path === "") {
    return "status";
  }
  return url.searchParams.get("route");
}

function requireConfig(config) {
  if (config.missing.length) {
    throw new ApiError(500, "NOT_CONFIGURED", `The server is missing ${config.missing.join(", ")}`);
  }
}

async function token(request, url, config) {
  requireConfig(config);
  if (url.searchParams.get("grant_type") !== "client_credentials") {
    throw new ApiError(400, "UNSUPPORTED_GRANT_TYPE", "grant_type must be client_credentials");
  }
  const nonce = url.searchParams.get("nonce");
  if (!nonce) {
    throw new ApiError(400, "NONCE_REQUIRED", "nonce is required");
  }
  const consumer = basicCredentials(request.headers.get("authorization"));
  if (!consumer || !sameSecret(consumer.key, config.consumerKey) || !sameSecret(consumer.secret, config.consumerSecret)) {
    throw new ApiError(401, "INVALID_CONSUMER", "The consumer key or secret is not valid");
  }
  const text = await request.text();
  const body = text ? parseJson(text) : {};
  const subject = body?.claims?.subject || consumer.key;
  return json(200, await issueToken(config, { nonce, subject }));
}

async function authorize(request, url, config, body) {
  requireConfig(config);
  await verifyBearer(config, request.headers.get("authorization"), url.searchParams.get("nonce"));
  return checkClientHeader(config, body.client_header);
}

async function add(request, url, config, store, maxContentBytes) {
  const started = performance.now();
  const raw = await request.text();
  const body = parseJson(raw);
  const header = await authorize(request, url, config, body);
  return json(200, await storeDocument(body, header, store, maxContentBytes, { requestBytes: Buffer.byteLength(raw), started }));
}

// Direct upload, step 1: a one-time link for sending the Add document body straight to
// storage, so it never passes through this function and Vercel's 4.5 MB limit doesn't apply.
async function uploadUrl(request, url, config, store) {
  const body = parseJson(await request.text());
  const header = await authorize(request, url, config, body);
  const uploadId = randomUUID().toUpperCase();
  const target = await store.createUploadTarget(uploadId, MAX_UPLOAD_BYTES);
  return json(200, {
    upload_id: uploadId,
    upload_method: "PUT",
    upload_url: target.url,
    upload_headers: target.headers,
    expires_at: new Date(target.validUntil).toISOString(),
    unique_request_id: header.unique_request_id,
  });
}

// Direct upload, step 3: checks the uploaded body as Add document would, then stores it.
// The uploaded body carries no client_header; this call's header authorizes it.
async function commit(request, url, config, store, maxContentBytes) {
  const started = performance.now();
  const body = parseJson(await request.text());
  const header = await authorize(request, url, config, body);
  const uploadId = requireString(body.upload_id, "upload_id", header.unique_request_id);
  const raw = await store.readUpload(uploadId);
  if (raw == null) {
    throw new ApiError(404, "UPLOAD_NOT_FOUND", `Nothing was uploaded for ${uploadId}`, header.unique_request_id);
  }
  try {
    return json(200, await storeDocument(parseJson(raw), header, store, maxContentBytes, {
      requestBytes: Buffer.byteLength(raw),
      started,
      uploadId,
    }));
  } finally {
    await store.deleteUpload(uploadId);
  }
}

async function storeDocument(body, header, store, maxContentBytes, { requestBytes, started, uploadId }) {
  const requestId = header.unique_request_id;

  const docClass = requireString(body.doc_class, "doc_class", requestId);
  const properties = Array.isArray(body.property_list) ? body.property_list : [];
  const items = body.content_info_list;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "CONTENT_REQUIRED", "content_info_list needs at least one entry", requestId);
  }

  let base64Length = 0;
  const contents = items.map((item, index) => {
    const field = `content_info_list[${index}]`;
    const name = requireString(item?.content_name, `${field}.content_name`, requestId);
    const encoded = requireString(item?.content_bytes, `${field}.content_bytes`, requestId);
    if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
      throw new ApiError(400, "INVALID_CONTENT_BYTES", `${field}.content_bytes is not valid base64`, requestId);
    }
    base64Length += encoded.length;
    return { name, mimeType: item.mime_type || mimeTypeFor(name), bytes: Buffer.from(encoded, "base64") };
  });
  const size = contents.reduce((sum, content) => sum + content.bytes.length, 0);
  if (size > maxContentBytes) {
    throw new ApiError(413, "CONTENT_TOO_LARGE", `The content is ${size} bytes; the maximum is ${maxContentBytes}`, requestId);
  }

  const documentId = `{${randomUUID().toUpperCase()}}`;
  await store.putDocument(documentId, {
    document_id: documentId,
    doc_class: docClass,
    property_list: properties,
    contents: contents.map((content, index) => ({
      content_name: content.name,
      mime_type: content.mimeType,
      size: content.bytes.length,
      page_number: index + 1,
    })),
    creator: header.client_id,
    end_user_id: header.end_user_id,
    unique_request_id: requestId,
    date_created: new Date().toISOString(),
  }, contents);

  return {
    document_id: documentId,
    doc_class: docClass,
    content_size: size,
    unique_request_id: requestId,
    diagnostics: {
      request_body_bytes: requestBytes,
      content_base64_length: base64Length,
      server_ms: Math.round(performance.now() - started),
      ...(uploadId ? { upload_id: uploadId } : {}),
    },
  };
}

async function getContent(request, url, config, store) {
  const body = parseJson(await request.text());
  const header = await authorize(request, url, config, body);
  const requestId = header.unique_request_id;
  const info = body.content_request_info ?? {};
  const documentId = requireString(info.document_id, "content_request_info.document_id", requestId);

  const document = SYNTHETIC_ID.test(documentId)
    ? syntheticDocument(documentId)
    : await storedDocument(store, documentId);
  if (!document) {
    throw new ApiError(404, "DOCUMENT_NOT_FOUND", `There is no document ${documentId}`, requestId);
  }

  const total = document.contents.length;
  const start = info.start_page_number ?? 1;
  if (!Number.isInteger(start) || start < 1 || start > total) {
    throw new ApiError(400, "INVALID_PAGE_RANGE", `start_page_number must be 1 to ${total}`, requestId);
  }
  const end = Math.min(info.end_page_number ?? total, start + PAGES_PER_CALL - 1, total);
  const pages = document.contents.filter((page) => page.page_number >= start && page.page_number <= end);
  const sources = await Promise.all(pages.map((page) => document.open(page.page_number)));
  if (sources.some((source) => !source)) {
    throw new ApiError(500, "CONTENT_MISSING", `The content of ${documentId} could not be read`, requestId);
  }

  const wanted = new Set(Array.isArray(info.properties) ? info.properties : []);
  const shell = {
    document_info: {
      doc_class: document.doc_class,
      document_id: document.document_id,
      property_list: [
        { name: "ContentSize", values: pages.reduce((sum, page) => sum + page.size, 0) },
        ...document.property_list.filter((property) => wanted.has(property.name)),
      ],
      content_info_list: pages.map((page, index) => ({
        content_name: page.content_name,
        content_bytes: placeholder(index),
        mime_type: page.mime_type,
        page_number: page.page_number,
      })),
      annotations: "",
      total_pages: total,
    },
  };
  return streamedJson(shell, sources);
}

async function storedDocument(store, documentId) {
  const meta = await store.getMeta(documentId);
  return meta && { ...meta, open: (page) => store.openContent(documentId, page) };
}

async function status(store, config) {
  let recent = [];
  let storeError = null;
  try {
    recent = await store.listRecent(20);
  } catch (error) {
    storeError = error.message;
  }
  return new Response(statusPage({ missing: config.missing, recent, storeError }), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const placeholder = (index) => `@@CONTENT_${index}@@`;

// Streaming keeps large responses clear of Vercel's 4.5 MB response limit.
function streamedJson(shell, sources) {
  const parts = JSON.stringify(shell).split(/"@@CONTENT_\d+@@"/);
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for (let index = 0; index < sources.length; index++) {
          controller.enqueue(encoder.encode(`${parts[index]}"`));
          for await (const chunk of base64Chunks(sources[index])) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.enqueue(encoder.encode('"'));
        }
        controller.enqueue(encoder.encode(parts[sources.length]));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object") {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be a JSON object");
  }
}

function requireString(value, field, requestId) {
  if (typeof value !== "string" || value === "") {
    throw new ApiError(400, "FIELD_REQUIRED", `${field} is required`, requestId);
  }
  return value;
}

function json(status, value) {
  return Response.json(value, { status });
}

function errorResponse(error) {
  if (error instanceof ApiError) {
    return json(error.status, {
      error_code: error.code,
      error_message: error.message,
      unique_request_id: error.requestId ?? null,
    });
  }
  console.error(error);
  return json(500, { error_code: "SERVER_ERROR", error_message: error.message, unique_request_id: null });
}
