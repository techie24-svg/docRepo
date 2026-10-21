// Sets the FileNet_API External Credential's values in an org from ../../.secrets.env.
// Secrets can't travel in metadata, so run this after each deployment to a new org.
//
//   node salesforce/scripts/set-credentials.mjs <org alias>
//
// The request body goes to the Salesforce CLI on stdin, so secrets never reach disk or argv.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const org = process.argv[2];
if (!org) {
  console.error("usage: node salesforce/scripts/set-credentials.mjs <org alias>");
  process.exit(1);
}

const secrets = {};
for (const line of readFileSync(new URL("../../.secrets.env", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.+)$/.exec(line.trim());
  if (match) {
    secrets[match[1]] = match[2];
  }
}
for (const name of ["CONSUMER_KEY", "CONSUMER_SECRET", "CLIENT_ID", "CLIENT_PASSWORD"]) {
  if (!secrets[name]) {
    console.error(`.secrets.env has no ${name}`);
    process.exit(1);
  }
}

const body = JSON.stringify({
  externalCredential: "FileNet_API",
  authenticationProtocol: "Custom",
  principalName: "FileNetPrincipal",
  principalType: "NamedPrincipal",
  credentials: {
    client_id: { value: secrets.CLIENT_ID, encrypted: false },
    client_password: { value: secrets.CLIENT_PASSWORD, encrypted: true },
    basic_token: {
      value: Buffer.from(`${secrets.CONSUMER_KEY}:${secrets.CONSUMER_SECRET}`).toString("base64"),
      encrypted: true,
    },
  },
});

function request(method) {
  const result = spawnSync(
    "sf",
    ["api", "request", "rest", "/services/data/v62.0/named-credentials/credential", "-X", method, "-b", "-", "-o", org],
    { input: body, encoding: "utf8" },
  );
  return `${result.stdout}\n${result.stderr}`;
}

// POST creates the values; once they exist, PUT replaces them.
let output = request("POST");
if (/already exist|CONFLICT|DUPLICATE/i.test(output)) {
  output = request("PUT");
}
const ok = /"externalCredential"\s*:\s*"FileNet_API"/.test(output);
console.log(ok ? "FileNet_API credential values are set." : "Setting the credential values failed:");
if (!ok) {
  console.log(output.replace(/"value"\s*:\s*"[^"]*"/g, '"value":"<hidden>"').slice(0, 1500));
  process.exit(1);
}
