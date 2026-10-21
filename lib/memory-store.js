// In-memory stand-in for the Blob store, used by the tests.
export function memoryStore() {
  const documents = new Map();
  const uploads = new Map();
  const key = (documentId) => documentId.replace(/[{}]/g, "").toUpperCase();

  return {
    async createUploadTarget(uploadId) {
      return { url: `memory://uploads/${uploadId}`, validUntil: Date.now() + 60_000, headers: {} };
    },

    // Stands in for the client's PUT to the upload URL.
    receiveUpload(uploadId, text) {
      uploads.set(uploadId, text);
    },

    hasUpload(uploadId) {
      return uploads.has(uploadId);
    },

    async readUpload(uploadId) {
      return uploads.get(uploadId) ?? null;
    },

    async deleteUpload(uploadId) {
      uploads.delete(uploadId);
    },

    async putDocument(documentId, meta, contents) {
      documents.set(key(documentId), { meta, bytes: contents.map((c) => c.bytes), at: new Date() });
    },

    async getMeta(documentId) {
      return documents.get(key(documentId))?.meta ?? null;
    },

    async openContent(documentId, page) {
      const bytes = documents.get(key(documentId))?.bytes[page - 1];
      if (!bytes) {
        return null;
      }
      return (async function* chunks() {
        for (let i = 0; i < bytes.length; i += 1000) {
          yield bytes.subarray(i, i + 1000);
        }
      })();
    },

    async listRecent(limit) {
      return [...documents.entries()]
        .map(([k, d]) => ({ document_id: `{${k}}`, size: d.bytes.reduce((s, b) => s + b.length, 0), uploaded_at: d.at }))
        .reverse()
        .slice(0, limit);
    },
  };
}
