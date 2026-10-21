import { timingSafeEqual } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";

import { ApiError } from "./errors.js";

const ISSUER = "docrepo-apigee-mock";
const AUDIENCE = "filenet-cm-api";
const TOKEN_SECONDS = 3600;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEADER_FIELDS = ["client_id", "client_password", "end_user_id", "request_time_stamp", "unique_request_id"];

export function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function basicCredentials(header) {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
  if (!match) {
    return null;
  }
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const split = decoded.indexOf(":");
  return split < 0 ? null : { key: decoded.slice(0, split), secret: decoded.slice(split + 1) };
}

function signingKey(config) {
  return new TextEncoder().encode(config.jwtSecret);
}

export async function issueToken(config, { nonce, subject }) {
  const accessToken = await new SignJWT({ nonce })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_SECONDS}s`)
    .sign(signingKey(config));
  return { access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_SECONDS };
}

// The API URL must carry the same nonce that was used to generate the JWT.
export async function verifyBearer(config, authorization, nonce) {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) {
    throw new ApiError(401, "TOKEN_REQUIRED", "Authorization: Bearer <JWT> is required");
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(match[1], signingKey(config), { issuer: ISSUER, audience: AUDIENCE }));
  } catch (error) {
    throw new ApiError(401, "INVALID_TOKEN", `The JWT is not valid: ${error.code ?? error.message}`);
  }
  if (!nonce || payload.nonce !== nonce) {
    throw new ApiError(401, "NONCE_MISMATCH", "The nonce in the URL doesn't match the nonce the JWT was issued for");
  }
  return payload;
}

export function checkClientHeader(config, header) {
  if (header === null || typeof header !== "object") {
    throw new ApiError(400, "CLIENT_HEADER_REQUIRED", "client_header is required");
  }
  const missing = HEADER_FIELDS.filter((field) => typeof header[field] !== "string" || header[field] === "");
  if (missing.length) {
    throw new ApiError(400, "CLIENT_HEADER_INCOMPLETE", `client_header is missing ${missing.join(", ")}`, header.unique_request_id);
  }
  if (!TIMESTAMP.test(header.request_time_stamp)) {
    throw new ApiError(400, "INVALID_TIMESTAMP", "request_time_stamp must be yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", header.unique_request_id);
  }
  if (!sameSecret(header.client_id, config.clientId) || !sameSecret(header.client_password, config.clientPassword)) {
    throw new ApiError(403, "INVALID_CLIENT", "client_id or client_password is not valid", header.unique_request_id);
  }
  return header;
}
