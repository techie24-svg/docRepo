@IsTest
public class FileNetCalloutMock implements HttpCalloutMock {

    public static final String DOCUMENT_ID = '{11111111-2222-3333-4444-555555555555}';
    public static final String UPLOAD_ID = 'A1B2C3D4-0000-1111-2222-333344445555';
    public static final String UPLOAD_URL = 'https://vercel.com/api/blob/?pathname=uploads%2F' + UPLOAD_ID + '.json&vercel-blob-signature=test';

    public Integer addStatus = 200;
    public Integer commitStatus = 200;
    // When set, the upload to storage fails inside Salesforce, as an oversized request does.
    public String uploadCalloutError;
    public String content = EncodingUtil.base64Encode(Blob.valueOf('%PDF-1.4 test'));
    public List<HttpRequest> requests = new List<HttpRequest>();

    public HttpResponse respond(HttpRequest request) {
        requests.add(request);
        HttpResponse response = new HttpResponse();
        response.setHeader('Content-Type', 'application/json');
        response.setStatusCode(200);
        String endpoint = request.getEndpoint();
        if (endpoint.contains('/auth/oauth/v2/token/generate')) {
            response.setBody('{"access_token":"test-jwt","token_type":"Bearer","expires_in":3600}');
        } else if (endpoint.contains('/document/uploadUrl')) {
            response.setBody('{"upload_id":"' + UPLOAD_ID + '","upload_method":"PUT","upload_url":"' + UPLOAD_URL
                + '","upload_headers":{"x-api-version":"13","x-vercel-blob-access":"private"}}');
        } else if (endpoint.startsWith('https://vercel.com/api/blob/')) {
            if (uploadCalloutError != null) {
                throw new CalloutException(uploadCalloutError);
            }
            response.setBody('{"pathname":"uploads/' + UPLOAD_ID + '.json","contentType":"application/json"}');
        } else if (endpoint.contains('/document/commit')) {
            response.setStatusCode(commitStatus);
            response.setBody(commitStatus == 200
                ? '{"document_id":"' + DOCUMENT_ID + '","content_size":13,"diagnostics":{"server_ms":4,"upload_id":"' + UPLOAD_ID + '"}}'
                : '{"error_code":"CONTENT_TOO_LARGE","error_message":"The content is 21000000 bytes; the maximum is 20971520","unique_request_id":null}');
        } else if (endpoint.contains('/document/add')) {
            response.setStatusCode(addStatus);
            response.setBody(addStatus == 200
                ? '{"document_id":"' + DOCUMENT_ID + '","content_size":13,"diagnostics":{"server_ms":4}}'
                : 'Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE');
        } else {
            response.setBody('{"document_info":{"document_id":"' + DOCUMENT_ID + '","content_info_list":[{'
                + '"content_name":"Application form.pdf","content_bytes":"' + content
                + '","mime_type":"application/pdf","page_number":1}],"annotations":"","total_pages":1}}');
        }
        return response;
    }
}
