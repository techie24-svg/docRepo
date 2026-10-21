public with sharing class FileNetClient {

    private static final String ENDPOINT = 'callout:FileNet_CM';
    private static final String CREDENTIAL = '{!$Credential.FileNet_API.';
    private static final Integer TOKEN_TIMEOUT_MS = 20000;
    private static final Integer CALL_TIMEOUT_MS = 100000;
    private static final Integer DETAIL_LENGTH = 2000;

    // What one FileNet call cost. Filled in even when the call fails.
    public class Call {
        public String requestId = UUID.randomUUID().toString();
        public Integer statusCode;
        public Integer bodyBytes;
        public Integer heapBytes;
        public Long elapsedMs;
    }

    public class FileNetException extends Exception {
        public Call call;
    }

    public class AddResult {
        public Call call;
        public String documentId;
        public String detail;
    }

    public class ContentResult {
        public Call call;
        public String fileName;
        public String mimeType;
        public String base64;
    }

    // Pass encodedContent straight from base64Encode: the body then holds the only large copy.
    public static AddResult addDocument(String docClass, String fileName, String documentType, String encodedContent) {
        Call call = new Call();
        String nonce = newNonce();
        String jwt = token(nonce, call);
        String prefix = '{"client_header":' + clientHeader(call.requestId)
            + ',"doc_class":' + JSON.serialize(docClass)
            + ',"property_list":[{"name":"DocType","values":' + JSON.serialize(documentType) + '}]'
            + ',"content_info_list":[{"content_name":' + JSON.serialize(fileName) + ',"content_bytes":"';
        String body = String.join(new List<String>{ prefix, encodedContent, '"}]}' }, '');
        encodedContent = null;
        call.bodyBytes = body.length();

        HttpResponse response = send('/v1/document/add', nonce, jwt, body, call);
        body = null;
        String text = response.getBody();
        if (call.statusCode != 200) {
            throw failure(errorText(call.statusCode, text), call);
        }
        Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(text);
        AddResult added = new AddResult();
        added.call = call;
        added.documentId = (String) result.get('document_id');
        added.detail = result.containsKey('diagnostics') ? JSON.serialize(result.get('diagnostics')) : null;
        return added;
    }

    public static ContentResult getContent(String documentId) {
        Call call = new Call();
        String nonce = newNonce();
        String jwt = token(nonce, call);
        String body = '{"client_header":' + clientHeader(call.requestId)
            + ',"content_request_info":{"document_id":' + JSON.serialize(documentId) + ',"get_annotations":false}}';

        HttpResponse response = send('/v2/document/getContent', nonce, jwt, body, call);
        String text = response.getBody();
        response = null;
        call.bodyBytes = text.length();
        if (call.statusCode != 200) {
            throw failure(errorText(call.statusCode, text), call);
        }
        ContentResult result = firstContent(text);
        call.heapBytes = Limits.getHeapSize();
        result.call = call;
        return result;
    }

    private static String token(String nonce, Call call) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(ENDPOINT + '/auth/oauth/v2/token/generate?grant_type=client_credentials&nonce=' + nonce);
        request.setMethod('POST');
        request.setHeader('Authorization', 'Basic ' + CREDENTIAL + 'basic_token}');
        request.setHeader('Content-Type', 'application/json');
        request.setBody('{}');
        request.setTimeout(TOKEN_TIMEOUT_MS);
        HttpResponse response;
        try {
            response = new Http().send(request);
        } catch (CalloutException e) {
            throw failure('The token call failed: ' + e.getMessage(), call);
        }
        if (response.getStatusCode() != 200) {
            call.statusCode = response.getStatusCode();
            throw failure('The token call failed. ' + errorText(response.getStatusCode(), response.getBody()), call);
        }
        return (String) ((Map<String, Object>) JSON.deserializeUntyped(response.getBody())).get('access_token');
    }

    // The URL carries the same nonce the JWT was issued for.
    private static HttpResponse send(String path, String nonce, String jwt, String body, Call call) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(ENDPOINT + path + '?nonce=' + nonce);
        request.setMethod('POST');
        request.setHeader('Authorization', 'Bearer ' + jwt);
        request.setHeader('Content-Type', 'application/json');
        request.setTimeout(CALL_TIMEOUT_MS);
        request.setBody(body);
        call.heapBytes = Limits.getHeapSize();
        Long started = System.currentTimeMillis();
        try {
            HttpResponse response = new Http().send(request);
            call.statusCode = response.getStatusCode();
            return response;
        } catch (CalloutException e) {
            throw failure(e.getMessage(), call);
        } finally {
            call.elapsedMs = System.currentTimeMillis() - started;
        }
    }

    private static String clientHeader(String requestId) {
        return '{"client_id":"' + CREDENTIAL + 'client_id}"'
            + ',"client_password":"' + CREDENTIAL + 'client_password}"'
            + ',"end_user_id":' + JSON.serialize(endUserId())
            + ',"request_time_stamp":"' + Datetime.now().formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\'') + '"'
            + ',"unique_request_id":"' + requestId + '"}';
    }

    private static String endUserId() {
        User user = [SELECT FederationIdentifier, Username FROM User WHERE Id = :UserInfo.getUserId()];
        return String.isBlank(user.FederationIdentifier) ? user.Username : user.FederationIdentifier;
    }

    private static String newNonce() {
        return EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(16);
    }

    // Salesforce uploads have one content element, so only the first is read.
    private static ContentResult firstContent(String text) {
        ContentResult result = new ContentResult();
        JSONParser parser = JSON.createParser(text);
        while (parser.nextToken() != null) {
            if (parser.getCurrentToken() != JSONToken.FIELD_NAME) {
                continue;
            }
            String field = parser.getText();
            parser.nextToken();
            if (field == 'content_bytes' && result.base64 == null) {
                result.base64 = parser.getText();
            } else if (field == 'content_name' && result.fileName == null) {
                result.fileName = parser.getText();
            } else if (field == 'mime_type' && result.mimeType == null) {
                result.mimeType = parser.getText();
            }
        }
        return result;
    }

    private static String errorText(Integer statusCode, String text) {
        String detail = text == null ? '' : text;
        try {
            Object parsed = JSON.deserializeUntyped(detail);
            if (parsed instanceof Map<String, Object> && ((Map<String, Object>) parsed).containsKey('error_code')) {
                Map<String, Object> error = (Map<String, Object>) parsed;
                detail = error.get('error_code') + ': ' + error.get('error_message');
            }
        } catch (JSONException e) {
            // Not JSON, for example Vercel's own 413 page; keep the raw text.
        }
        return 'HTTP ' + statusCode + ': ' + detail.normalizeSpace().left(DETAIL_LENGTH);
    }

    private static FileNetException failure(String message, Call call) {
        FileNetException error = new FileNetException(message);
        error.call = call;
        return error;
    }
}
