import { del, get, issueSignedToken, list, parseStoreIdFromDelegationToken, presignUrl, put } from "@vercel/blob";

const PRIVATE = { access: "private" };
const UPLOAD_MINUTES = 15;
// The Blob API version @vercel/blob 2.8 sends; a presigned PUT needs it as a header.
const BLOB_API_VERSION = "13";

function folder(documentId) {
  return `documents/${documentId.replace(/[{}]/g, "").toUpperCase()}`;
}

const uploadPath = (uploadId) => `uploads/${uploadId}.json`;

// Files live in a private Blob store; on Vercel the SDK signs in with OIDC.
export function blobStore() {
  return {
    async putDocument(documentId, meta, contents) {
      const base = folder(documentId);
      await Promise.all(contents.map((content, index) =>
        put(`${base}/content/${index + 1}`, content.bytes, { ...PRIVATE, contentType: content.mimeType }),
      ));
      await put(`${base}/meta.json`, JSON.stringify(meta), { ...PRIVATE, contentType: "application/json" });
    },

    async getMeta(documentId) {
      const result = await get(`${folder(documentId)}/meta.json`, PRIVATE);
      if (!result || result.statusCode !== 200) {
        return null;
      }
      return JSON.parse(await new Response(result.stream).text());
    },

    async openContent(documentId, page) {
      const result = await get(`${folder(documentId)}/content/${page}`, PRIVATE);
      return result && result.statusCode === 200 ? result.stream : null;
    },

    // A presigned PUT straight to Blob storage, so the upload skips this function.
    // The caller needs no Blob credentials: the URL carries a signature scoped to this one path.
    async createUploadTarget(uploadId, maximumSizeInBytes) {
      const pathname = uploadPath(uploadId);
      const validUntil = Date.now() + UPLOAD_MINUTES * 60 * 1000;
      const signed = await issueSignedToken({ pathname, operations: ["put"], validUntil, maximumSizeInBytes });
      const { presignedUrl } = await presignUrl(signed, {
        operation: "put",
        pathname,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        maximumSizeInBytes,
      });
      return {
        url: presignedUrl,
        validUntil,
        headers: {
          "x-api-version": BLOB_API_VERSION,
          "x-vercel-blob-store-id": parseStoreIdFromDelegationToken(signed.delegationToken),
          "x-vercel-blob-access": "private",
          "x-content-type": "application/json",
        },
      };
    },

    async readUpload(uploadId) {
      const result = await get(uploadPath(uploadId), PRIVATE);
      return result && result.statusCode === 200 ? new Response(result.stream).text() : null;
    },

    async deleteUpload(uploadId) {
      await del(uploadPath(uploadId));
    },

    async listRecent(limit) {
      const { blobs } = await list({ prefix: "documents/" });
      const byDocument = new Map();
      for (const blob of blobs) {
        const [, key, kind] = blob.pathname.split("/");
        const entry = byDocument.get(key) ?? { document_id: `{${key}}`, size: 0, uploaded_at: blob.uploadedAt };
        if (kind === "content") {
          entry.size += blob.size;
        } else {
          entry.uploaded_at = blob.uploadedAt;
        }
        byDocument.set(key, entry);
      }
      return [...byDocument.values()]
        .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at))
        .slice(0, limit);
    },
  };
}
