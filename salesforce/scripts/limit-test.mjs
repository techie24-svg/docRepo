// Runs uploads or views of chosen sizes through FileNetDocumentService and prints
// what each one cost and how it ended.
//
//   node salesforce/scripts/limit-test.mjs <org> <client account id> upload sync 1 3 3.5 4.2
//   node salesforce/scripts/limit-test.mjs <org> <client account id> upload async 5 8 9.5
//   node salesforce/scripts/limit-test.mjs <org> <client account id> view sync 3.5 4 4.5
//
// Upload files are random bytes created through the REST API, so building them costs no
// Apex heap. Each call to the service runs in its own anonymous Apex transaction, which
// has the same synchronous limits as a call from the component. Views use synthetic
// documents of the given size.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [org, clientId, operation, mode, ...sizes] = process.argv.slice(2);
if (!org || !clientId || !["upload", "view"].includes(operation) || !["sync", "async"].includes(mode) || !sizes.length) {
  console.error("usage: limit-test.mjs <org> <client account id> upload|view sync|async <MB> [<MB> ...]");
  process.exit(1);
}
if (operation === "view" && mode === "async") {
  console.error("Views run synchronously, as they do from the component.");
  process.exit(1);
}

const MB = 1024 * 1024;
const workDir = mkdtempSync(join(tmpdir(), "filenet-limit-"));

function sf(args, input) {
  const result = spawnSync("sf", [...args, "--target-org", org, "--json"], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * MB,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`sf ${args[0]} ${args[1]} failed: ${(result.stderr || result.stdout).slice(0, 500)}`);
  }
}

function anonymousApex(source) {
  const file = join(workDir, "run.apex");
  writeFileSync(file, source);
  const result = sf(["apex", "run", "--file", file]).result;
  if (!result.success) {
    return { failure: result.exceptionMessage || result.compileProblem || "Anonymous Apex failed" };
  }
  // The log also echoes the source, which contains "OUTCOME " too.
  const line = (result.logs ?? "").split("\n").find((entry) => entry.includes("|USER_DEBUG|") && entry.includes("OUTCOME "));
  return line ? JSON.parse(line.slice(line.indexOf("OUTCOME ") + 8)) : { failure: "No outcome in the debug log" };
}

function stagedFile(megabytes) {
  const bytes = randomBytes(Math.round(megabytes * MB));
  const body = JSON.stringify({
    Title: `Limit test ${megabytes} MB`,
    PathOnClient: `limit-test-${megabytes}MB.bin`,
    VersionData: bytes.toString("base64"),
  });
  const response = sf(["api", "request", "rest", "/services/data/v62.0/sobjects/ContentVersion", "-X", "POST", "-b", "-"], body);
  const created = typeof response?.result?.body === "string" ? JSON.parse(response.result.body) : response?.result?.body;
  const id = created?.id;
  if (!id) {
    const detail = response?.result?.body ?? response?.message ?? response;
    throw new Error(`Couldn't stage a ${megabytes} MB file: ${JSON.stringify(detail).slice(0, 300)}`);
  }
  return id;
}

function testRow(testId) {
  const query = `SELECT Status__c, File_Bytes__c, Body_Bytes__c, Heap_Bytes__c, Heap_Limit_Bytes__c, Callout_Ms__c, Http_Status__c, Detail__c FROM FileNet_Test__c WHERE Id = '${testId}'`;
  const [row] = sf(["data", "query", "--query", query]).result.records;
  return {
    status: row.Status__c,
    fileBytes: row.File_Bytes__c,
    bodyBytes: row.Body_Bytes__c,
    heapBytes: row.Heap_Bytes__c,
    heapLimitBytes: row.Heap_Limit_Bytes__c,
    elapsedMs: row.Callout_Ms__c,
    httpStatus: row.Http_Status__c,
    detail: row.Detail__c,
  };
}

async function waitForJob(testId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const row = testRow(testId);
    if (row.status !== "Running") {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { status: "Running", detail: "Still running after 3 minutes" };
}

const mb = (bytes) => (bytes == null ? "" : (bytes / MB).toFixed(2));
const rows = [];

for (const size of sizes.map(Number)) {
  let outcome;
  try {
    if (operation === "upload") {
      const versionId = stagedFile(size);
      outcome = anonymousApex(
        `FileNetDocumentService.Outcome o = FileNetDocumentService.upload('${clientId}', '${versionId}', 'Limit test', ${mode === "async"});\n` +
        `System.debug(LoggingLevel.ERROR, 'OUTCOME ' + JSON.serialize(o));`,
      );
      if (outcome.failure) {
        anonymousApex(
          `Id t = FileNetDocumentService.recordFailure('Upload', '${clientId}', '${versionId}', 'limit-test-${size}MB.bin', ${JSON.stringify(outcome.failure).replace(/'/g, "\\'")});\n` +
          `System.debug(LoggingLevel.ERROR, 'OUTCOME {}');`,
        );
      } else if (mode === "async") {
        outcome = await waitForJob(outcome.testId);
      }
    } else {
      const created = anonymousApex(
        `Id d = FileNetDocumentService.createSyntheticDocument('${clientId}', ${size});\n` +
        `System.debug(LoggingLevel.ERROR, 'OUTCOME ' + JSON.serialize(new Map<String, Object>{ 'id' => d }));`,
      );
      outcome = created.failure ? created : anonymousApex(
        `FileNetDocumentService.Outcome o = FileNetDocumentService.view('${created.id}');\n` +
        `o.base64 = o.base64 == null ? null : String.valueOf(o.base64.length());\n` +
        `System.debug(LoggingLevel.ERROR, 'OUTCOME ' + JSON.serialize(o));`,
      );
    }
  } catch (error) {
    outcome = { failure: error.message };
  }
  const status = outcome.failure
    ? (/heap|size limit|cpu time/i.test(outcome.failure) ? "Salesforce limit" : "Failed")
    : outcome.status;
  rows.push({
    "File MB": size.toFixed(2),
    Mode: mode,
    Status: status,
    "Body MB": mb(outcome.bodyBytes),
    "Heap MB": outcome.heapBytes == null ? "" : `${mb(outcome.heapBytes)} / ${mb(outcome.heapLimitBytes)}`,
    "Call ms": outcome.elapsedMs ?? "",
    HTTP: outcome.httpStatus ?? "",
    Detail: (outcome.failure ?? outcome.detail ?? "").replace(/\s+/g, " ").slice(0, 90),
  });
  console.log(`${operation} ${size} MB ${mode}: ${status}`);
}

rmSync(workDir, { recursive: true, force: true });
console.table(rows);
