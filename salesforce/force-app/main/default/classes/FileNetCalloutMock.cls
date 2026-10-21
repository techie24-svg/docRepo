@IsTest
public class FileNetCalloutMock implements HttpCalloutMock {

    public static final String DOCUMENT_ID = '{11111111-2222-3333-4444-555555555555}';

    public Integer addStatus = 200;
    public String content = EncodingUtil.base64Encode(Blob.valueOf('%PDF-1.4 test'));
    public List<HttpRequest> requests = new List<HttpRequest>();

    public HttpResponse respond(HttpRequest request) {
        requests.add(request);
        HttpResponse response = new HttpResponse();
        response.setHeader('Content-Type', 'application/json');
        String endpoint = request.getEndpoint();
        if (endpoint.contains('/auth/oauth/v2/token/generate')) {
            response.setStatusCode(200);
            response.setBody('{"access_token":"test-jwt","token_type":"Bearer","expires_in":3600}');
        } else if (endpoint.contains('/document/add')) {
            response.setStatusCode(addStatus);
            response.setBody(addStatus == 200
                ? '{"document_id":"' + DOCUMENT_ID + '","content_size":13,"diagnostics":{"server_ms":4}}'
                : 'Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE');
        } else {
            response.setStatusCode(200);
            response.setBody('{"document_info":{"document_id":"' + DOCUMENT_ID + '","content_info_list":[{'
                + '"content_name":"Application form.pdf","content_bytes":"' + content
                + '","mime_type":"application/pdf","page_number":1}],"annotations":"","total_pages":1}}');
        }
        return response;
    }
}
