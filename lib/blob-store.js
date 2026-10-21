import { get, list, put } from "@vercel/blob";

const PRIVATE = { access: "private" };

function folder(documentId) {
  return `documents/${documentId.replace(/[{}]/g, "").toUpperCase()}`;
}

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
