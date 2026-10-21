# docRepo: mock FileNet CM REST API for Salesforce upload tests

A stand-in for Guardian's FileNet CM REST APIs, deployed on Vercel, plus the Salesforce side used to measure how large a file Salesforce can upload and view. Use test files only.

| Path | What it is |
|---|---|
| `api/`, `lib/`, `vercel.json` | The mock API: one Vercel function, with `vercel.json` mapping the FileNet paths onto it |
| `test/` | Unit tests for the API (`npm test`) |
| `scripts/smoke.mjs` | End-to-end check of a deployment |
| `salesforce/` | Salesforce DX project: Apex, the `fileNetTester` Lightning component, the FileNet Test results object, the Named and External Credentials and a permission set |
| `salesforce/scripts/` | `set-credentials.mjs` stores the secrets in Salesforce; `limit-test.mjs` runs uploads and views of chosen sizes |

## The API

It follows the Guardian contract: get a token for a nonce, then call FileNet with that token and the same nonce.

| Call | What it does |
|---|---|
| `POST /auth/oauth/v2/token/generate?grant_type=client_credentials&nonce=N` | Basic auth with the consumer key and secret. Returns `access_token`, a JWT for nonce `N`. An external consumer's `{"claims": {"subject": ...}}` body is accepted. |
| `POST /v1/document/add?nonce=N` | Bearer JWT. The body has `client_header`, `doc_class`, `property_list` and `content_info_list` with base64 `content_bytes`. Returns `document_id`, for example `{35107322-7D40-C371-864F-78802A400000}`. |
| `POST /v2/document/getContent?nonce=N` | Bearer JWT. Returns `document_info` with base64 content, streamed. |
| `GET /` | Status page listing recent documents |

Every document call needs a `client_header` with `client_id`, `client_password`, `end_user_id`, `request_time_stamp` (`yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`) and `unique_request_id`. Errors come back as `{ error_code, error_message, unique_request_id }`.

### Direct upload

Vercel refuses any request over 4.5 MB to a function, which is a file of about 3.2 MB after base64 encoding. So the mock also has a direct upload, which sends the Add document body straight to Vercel Blob storage and keeps only small calls on the function. The Salesforce harness uses it.

| Step | Call | What it does |
|---|---|---|
| 1 | `POST /v1/document/uploadUrl?nonce=N` | Bearer JWT and `client_header`. Returns `upload_id`, a one-time `upload_url` (valid 15 minutes) and the `upload_headers` to send with it. |
| 2 | `PUT <upload_url>` | The Add document body without `client_header`, so no credentials reach storage. Goes to Vercel Blob, not the function, so the 4.5 MB limit doesn't apply. |
| 3 | `POST /v1/document/commit?nonce=N` | Bearer JWT, `client_header` and `upload_id`. Checks the uploaded body as Add document would, including FileNet's 20 MB limit (HTTP 413 `CONTENT_TOO_LARGE`), then returns `document_id`. |

The real FileNet API takes the whole body in one Add document call. The upload is the same size and shape either way, so it tests the same Salesforce limits.

Get content streams its response, so Vercel's 4.5 MB response limit doesn't apply to it either. A `document_id` of `{SYNTHETIC-<bytes>}` returns a generated PDF of that many bytes (1 KB to 50 MB), for testing views of large files.

## Deploy on Vercel

The current deployment is https://docpoc-virid.vercel.app: Vercel project `docpoc`, connected to this repository, with its storage and secrets set up. Pushing to `main` deploys it. To deploy it somewhere else:

1. Import this repository into Vercel. No framework preset is needed; it runs on Node 22 or later.
2. Add a Blob store to the project with private access (Storage, then Create, then Blob). The function signs in to it automatically.
3. Add five environment variables, each set to a long random value: `CONSUMER_KEY`, `CONSUMER_SECRET`, `CLIENT_ID`, `CLIENT_PASSWORD` and `JWT_SECRET`.
4. Deploy. The status page at the root says "ready" when the variables are set. For a full check, put the same five values in `.secrets.env` at the repository root and run `node scripts/smoke.mjs https://<your-app>.vercel.app`.

`.secrets.env` is ignored by git. The smoke test and the Salesforce credential script both read it.

## Salesforce

```
cd salesforce
sf project deploy start --source-dir force-app --target-org <org> --test-level RunSpecifiedTests --tests FileNetDocumentServiceTest
cd ..
node salesforce/scripts/set-credentials.mjs <org>
sf org assign permset --name FileNet_Upload_Tester --target-org <org>
```

`set-credentials.mjs` sends the secrets to the `FileNet_API` External Credential through the CLI's standard input, so they never touch disk or the command line. Secrets can't travel in metadata, so run it after deploying to any new org. If the Vercel address changes, update `namedCredentials/FileNet_CM.namedCredential-meta.xml`.

To test, open the **FileNet Upload Test** tab (or add the component to an Account page), pick a client, choose Synchronous or Asynchronous, and upload a file. Each run is saved as a FileNet Test record with the file size, request or response body size, heap used, call time and HTTP status. Uploaded files are staged in Salesforce, sent to the API, then deleted and removed from the Recycle Bin. To test views above the upload limit, use **Add synthetic document**, then **View**.

The same runs can be scripted, for example:

```
node salesforce/scripts/limit-test.mjs <org> <account id> upload sync 1 3 7
node salesforce/scripts/limit-test.mjs <org> <account id> upload async 5 12
node salesforce/scripts/limit-test.mjs <org> <account id> view sync 2 4 5
```

## Results so far

Playground sandbox, 21 October 2026. Sizes are in MiB. Synchronous runs use the same limits as a call from the component.

| File | Mode | Request or response body | Result |
|---|---|---|---|
| 1 | Upload, sync | 1.40 MB | Stored |
| 3 | Upload, sync | 4.19 MB | Stored |
| 3.3 to 7 | Upload, sync | 4.61 to 9.33 MB | Sent by Salesforce; refused by Vercel (413) |
| 8 | Upload, sync | 10.67 MB | Salesforce: `Exceeded max size limit of 10000000 with request size 10000001` |
| 5 to 12 | Upload, async | 6.99 to 16.00 MB | Sent by Salesforce; refused by Vercel (413) |
| 16 | Upload, async | — | Salesforce: `Apex heap size too large: 44742794` |
| 2 to 5 | View, sync | 2.67 to 6.67 MB | Retrieved |

What this shows:

- **Synchronous uploads** stop at a 10,000,000-byte request body, which is a file of about 7 MB. Salesforce's documentation still says 6 MB.
- **Asynchronous uploads** sent a 12 MB file. A 16 MB file ran out of heap, because the job holds the file, its base64 copy and the request body at the same time.
- **Views** returned 5 MB files synchronously. The heap reading went above its limit without an error, but the component also passes the file to the browser, so check large views in the component too.

These are sandbox measurements on the current release. Salesforce documents lower limits, so design to the documented ones, or repeat these tests in production before relying on the headroom.
