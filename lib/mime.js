// Extension to MIME type, taken from the FileNet CM REST API mapping table.
const TYPES = {
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eml: "message/rfc822",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  msg: "application/vnd.ms-outlook",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "text/xml",
  zip: "application/zip",
};

export function mimeTypeFor(fileName) {
  const dot = fileName.lastIndexOf(".");
  const extension = dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
  return TYPES[extension] ?? "application/octet-stream";
}
