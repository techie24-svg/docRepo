// Encodes a byte stream as base64 in chunks, holding back 1-2 bytes between
// chunks so padding only appears at the very end.
export async function* base64Chunks(source) {
  let carry = Buffer.alloc(0);
  for await (const chunk of source) {
    const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const bytes = carry.length ? Buffer.concat([carry, view]) : view;
    const usable = bytes.length - (bytes.length % 3);
    if (usable) {
      yield bytes.subarray(0, usable).toString("base64");
    }
    carry = Buffer.from(bytes.subarray(usable));
  }
  if (carry.length) {
    yield carry.toString("base64");
  }
}
