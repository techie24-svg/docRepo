import { LightningElement, api } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import userId from "@salesforce/user/Id";
import clientDocuments from "@salesforce/apex/FileNetDocumentService.clientDocuments";
import createSyntheticDocument from "@salesforce/apex/FileNetDocumentService.createSyntheticDocument";
import recentTests from "@salesforce/apex/FileNetDocumentService.recentTests";
import recordFailure from "@salesforce/apex/FileNetDocumentService.recordFailure";
import upload from "@salesforce/apex/FileNetDocumentService.upload";
import view from "@salesforce/apex/FileNetDocumentService.view";

const MB = 1024 * 1024;
const POLL_MS = 3000;
const SALESFORCE_LIMIT = /heap|size limit|cpu time/i;
const TWO_DECIMALS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const TIME = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

const TEST_COLUMNS = [
  { label: "Time", fieldName: "createdDate", type: "date", typeAttributes: TIME, initialWidth: 105 },
  { label: "Operation", fieldName: "operation", initialWidth: 95 },
  { label: "Mode", fieldName: "mode", initialWidth: 115 },
  { label: "File", fieldName: "fileName" },
  { label: "File MB", fieldName: "fileMb", type: "number", typeAttributes: TWO_DECIMALS, initialWidth: 85 },
  { label: "Body MB", fieldName: "bodyMb", type: "number", typeAttributes: TWO_DECIMALS, initialWidth: 90 },
  { label: "Heap MB (used / limit)", fieldName: "heap", initialWidth: 160 },
  { label: "Call ms", fieldName: "elapsedMs", type: "number", initialWidth: 85 },
  { label: "HTTP", fieldName: "httpStatus", type: "number", initialWidth: 70 },
  { label: "Status", fieldName: "status", initialWidth: 145 },
  { label: "Detail", fieldName: "detail", wrapText: true },
];

const DOCUMENT_COLUMNS = [
  { label: "Document", fieldName: "name" },
  { label: "FileNet Document ID", fieldName: "fileNetId" },
  { label: "MB", fieldName: "sizeMb", type: "number", typeAttributes: TWO_DECIMALS, initialWidth: 80 },
  { label: "Added", fieldName: "createdDate", type: "date", typeAttributes: TIME, initialWidth: 105 },
  { type: "button", initialWidth: 90, typeAttributes: { label: "View", name: "view", variant: "base" } },
];

const RESULT_THEMES = {
  Stored: "slds-theme_success",
  Retrieved: "slds-theme_success",
  Running: "slds-theme_info",
  "Rejected by server": "slds-theme_warning",
};

const toMb = (bytes) => (bytes == null ? null : bytes / MB);
const mbText = (bytes) => (bytes == null ? "" : (bytes / MB).toFixed(2));

function errorMessage(error) {
  if (Array.isArray(error?.body)) {
    return error.body.map((entry) => entry.message).join(", ");
  }
  return error?.body?.message || error?.message || "Unknown error";
}

function summary(operation, values) {
  const parts = [];
  if (values.fileBytes != null) {
    parts.push(`${mbText(values.fileBytes)} MB file`);
  }
  if (values.bodyBytes != null) {
    parts.push(`${operation === "View" ? "response" : "request"} body ${mbText(values.bodyBytes)} MB`);
  }
  if (values.heapBytes != null) {
    parts.push(`heap ${mbText(values.heapBytes)} of ${mbText(values.heapLimitBytes)} MB`);
  }
  if (values.elapsedMs != null) {
    parts.push(`${values.elapsedMs} ms`);
  }
  if (values.httpStatus != null) {
    parts.push(`HTTP ${values.httpStatus}`);
  }
  const ok = values.status === "Stored" || values.status === "Retrieved" || values.status === "Running";
  return { testId: values.testId, status: values.status, text: parts.join(" · "), detail: ok ? "" : values.detail };
}

function testRow(record) {
  return {
    id: record.Id,
    createdDate: record.CreatedDate,
    operation: record.Operation__c,
    mode: record.Mode__c,
    fileName: record.File_Name__c,
    fileMb: toMb(record.File_Bytes__c),
    bodyMb: toMb(record.Body_Bytes__c),
    heap: record.Heap_Bytes__c == null ? "" : `${mbText(record.Heap_Bytes__c)} / ${mbText(record.Heap_Limit_Bytes__c)}`,
    elapsedMs: record.Callout_Ms__c,
    httpStatus: record.Http_Status__c,
    status: record.Status__c,
    detail: record.Detail__c,
    values: {
      testId: record.Id,
      status: record.Status__c,
      detail: record.Detail__c,
      fileBytes: record.File_Bytes__c,
      bodyBytes: record.Body_Bytes__c,
      heapBytes: record.Heap_Bytes__c,
      heapLimitBytes: record.Heap_Limit_Bytes__c,
      elapsedMs: record.Callout_Ms__c,
      httpStatus: record.Http_Status__c,
    },
  };
}

function documentRow(record) {
  return {
    id: record.Id,
    name: record.Name,
    fileNetId: record.FileNet_Document_Id__c,
    sizeMb: toMb(record.File_Size__c),
    createdDate: record.CreatedDate,
  };
}

export default class FileNetTester extends LightningElement {
  @api recordId;

  pickedClientId;
  mode = "Synchronous";
  documentType = "Test";
  syntheticMb = 5;
  busy = false;
  lastResult;
  viewer;
  tests = [];
  documents = [];
  pollTimer;

  // Staged files belong to the uploader, not the client record, until Apex deletes them.
  stagingRecordId = userId;
  modeOptions = [
    { label: "Synchronous", value: "Synchronous" },
    { label: "Asynchronous", value: "Asynchronous" },
  ];
  testColumns = TEST_COLUMNS;
  documentColumns = DOCUMENT_COLUMNS;

  get clientId() {
    return this.recordId || this.pickedClientId;
  }

  get showClientPicker() {
    return !this.recordId;
  }

  get actionsDisabled() {
    return !this.clientId || this.busy;
  }

  get hasDocuments() {
    return this.documents.length > 0;
  }

  get resultClass() {
    const theme = RESULT_THEMES[this.lastResult?.status] ?? "slds-theme_error";
    return `slds-box slds-box_x-small slds-m-top_small ${theme}`;
  }

  connectedCallback() {
    this.refresh();
  }

  disconnectedCallback() {
    clearTimeout(this.pollTimer);
    this.releaseViewer();
  }

  handleClientChange(event) {
    this.pickedClientId = event.detail.recordId;
    this.refresh();
  }

  handleModeChange(event) {
    this.mode = event.detail.value;
  }

  handleTypeChange(event) {
    this.documentType = event.detail.value;
  }

  handleSyntheticChange(event) {
    this.syntheticMb = event.detail.value;
  }

  async handleUploadFinished(event) {
    const [file] = event.detail.files;
    if (!file) {
      return;
    }
    this.busy = true;
    this.releaseViewer();
    try {
      const result = await upload({
        clientId: this.clientId,
        contentVersionId: file.contentVersionId,
        documentType: this.documentType,
        runAsync: this.mode === "Asynchronous",
      });
      this.lastResult = summary("Upload", result);
    } catch (error) {
      this.lastResult = await this.reportFailure("Upload", file.contentVersionId, file.name, error);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  async handleRowAction(event) {
    const { row } = event.detail;
    this.busy = true;
    this.releaseViewer();
    try {
      const result = await view({ clientDocumentId: row.id });
      this.lastResult = summary("View", result);
      if (result.base64) {
        this.viewer = this.buildViewer(result);
      }
    } catch (error) {
      this.lastResult = await this.reportFailure("View", null, row.name, error);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  async handleCreateSynthetic() {
    this.busy = true;
    try {
      await createSyntheticDocument({ clientId: this.clientId, megabytes: Number(this.syntheticMb) });
      this.toast("Synthetic document added", "Choose View on it to test the download.", "success");
    } catch (error) {
      this.toast("Couldn't add the synthetic document", errorMessage(error), "error");
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  async refresh() {
    clearTimeout(this.pollTimer);
    try {
      const [tests, documents] = await Promise.all([
        recentTests(),
        this.clientId ? clientDocuments({ clientId: this.clientId }) : Promise.resolve([]),
      ]);
      this.tests = tests.map(testRow);
      this.documents = documents.map(documentRow);
      const finished = this.tests.find((row) => row.id === this.lastResult?.testId && row.status !== "Running");
      if (this.lastResult?.status === "Running" && finished) {
        this.lastResult = summary(finished.operation, finished.values);
      }
      if (this.tests.some((row) => row.status === "Running")) {
        // Asynchronous uploads finish in a Queueable; poll until they do.
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this.pollTimer = setTimeout(() => this.refresh(), POLL_MS);
      }
    } catch (error) {
      this.toast("Couldn't load the test runs", errorMessage(error), "error");
    }
  }

  // A heap or CPU limit ends the Apex transaction before it can log itself.
  async reportFailure(operation, contentVersionId, fileName, error) {
    const message = errorMessage(error);
    try {
      await recordFailure({ operation, clientId: this.clientId, contentVersionId, fileName, message });
    } catch (logError) {
      this.toast("Couldn't record the failure", errorMessage(logError), "error");
    }
    return {
      status: SALESFORCE_LIMIT.test(message) ? "Salesforce limit" : "Failed",
      text: fileName,
      detail: message,
    };
  }

  buildViewer(result) {
    const type = result.mimeType || "application/octet-stream";
    const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
    return {
      fileName: result.fileName,
      sizeText: `${mbText(bytes.length)} MB`,
      url: URL.createObjectURL(new Blob([bytes], { type })),
      isImage: type.startsWith("image/"),
      dataUrl: `data:${type};base64,${result.base64}`,
    };
  }

  releaseViewer() {
    if (this.viewer?.url) {
      URL.revokeObjectURL(this.viewer.url);
    }
    this.viewer = undefined;
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
