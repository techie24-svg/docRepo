import { createApp } from "../lib/app.js";
import { blobStore } from "../lib/blob-store.js";
import { configFromEnv } from "../lib/config.js";

export default { fetch: createApp({ store: blobStore(), config: configFromEnv() }) };
