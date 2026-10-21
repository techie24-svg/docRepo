// In-memory stand-in for the Blob store, used by the tests.
export function memoryStore() {
  const documents = new Map();
  const key = (documentId) => documentId.replace(/[{}]/g, "").toUpperCase();

  return {
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
