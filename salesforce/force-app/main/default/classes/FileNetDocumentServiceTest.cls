@IsTest
private class FileNetDocumentServiceTest {

    @TestSetup
    static void setup() {
        insert new Account(Name = 'FileNet Test Client');
    }

    // Field security on the new fields comes from the permission set, so tests run as a user who has it.
    private static User tester() {
        User user = new User(
            Alias = 'fntest',
            Email = 'filenet.tester@example.com',
            EmailEncodingKey = 'UTF-8',
            LastName = 'Tester',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = [SELECT Id FROM Profile WHERE Name = 'System Administrator'].Id,
            TimeZoneSidKey = 'America/New_York',
            Username = 'filenet.tester.' + EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(10) + '@example.com'
        );
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert user;
            insert new PermissionSetAssignment(
                AssigneeId = user.Id,
                PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'FileNet_Upload_Tester'].Id
            );
        }
        return user;
    }

    private static Id clientId() {
        return [SELECT Id FROM Account LIMIT 1].Id;
    }

    private static ContentVersion stagedFile() {
        ContentVersion version = new ContentVersion(
            Title = 'Application form',
            PathOnClient = 'Application form.pdf',
            VersionData = Blob.valueOf('%PDF-1.4 test')
        );
        insert version;
        return [SELECT Id, ContentDocumentId FROM ContentVersion WHERE Id = :version.Id];
    }

    @IsTest
    static void synchronousUploadStoresTheReferenceAndRemovesTheStagedFile() {
        System.runAs(tester()) {
            ContentVersion staged = stagedFile();
            FileNetCalloutMock mock = new FileNetCalloutMock();
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            FileNetDocumentService.Outcome result = FileNetDocumentService.upload(clientId(), staged.Id, 'Application', false);
            Test.stopTest();

            Assert.areEqual('Stored', result.status, result.detail ?? 'no detail');
            Assert.areEqual(FileNetCalloutMock.DOCUMENT_ID, result.documentId);
            IdentityDocument document = [
                SELECT Name, FileNet_Document_Id__c, Mime_Type__c, RelatedLegalEntityId FROM IdentityDocument
            ];
            Assert.areEqual('Application form.pdf', document.Name);
            Assert.areEqual(FileNetCalloutMock.DOCUMENT_ID, document.FileNet_Document_Id__c);
            Assert.areEqual('application/pdf', document.Mime_Type__c);
            Assert.areEqual(0, [SELECT COUNT() FROM ContentDocument WHERE Id = :staged.ContentDocumentId]);

            Assert.areEqual(4, mock.requests.size());
            Assert.isTrue(mock.requests[1].getEndpoint().startsWith('callout:FileNet_CM/v1/document/uploadUrl?nonce='));

            HttpRequest upload = mock.requests[2];
            Assert.areEqual('PUT', upload.getMethod());
            Assert.areEqual(FileNetCalloutMock.UPLOAD_URL, upload.getEndpoint());
            Assert.areEqual('private', upload.getHeader('x-vercel-blob-access'));
            Map<String, Object> uploaded = (Map<String, Object>) JSON.deserializeUntyped(upload.getBody());
            Assert.isFalse(uploaded.containsKey('client_header'), 'Credentials must not go to storage');
            Map<String, Object> item = (Map<String, Object>) ((List<Object>) uploaded.get('content_info_list'))[0];
            Assert.areEqual(EncodingUtil.base64Encode(Blob.valueOf('%PDF-1.4 test')), item.get('content_bytes'));

            HttpRequest committed = mock.requests[3];
            Assert.isTrue(committed.getEndpoint().startsWith('callout:FileNet_CM/v1/document/commit?nonce='));
            Assert.isTrue(committed.getHeader('Authorization').startsWith('Bearer '));
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(committed.getBody());
            Assert.areEqual(FileNetCalloutMock.UPLOAD_ID, body.get('upload_id'));
            Map<String, Object> header = (Map<String, Object>) body.get('client_header');
            Assert.areEqual('{!$Credential.FileNet_API.client_password}', header.get('client_password'));
            Assert.areEqual(result.testId, [SELECT Id FROM FileNet_Test__c WHERE Request_Id__c = :String.valueOf(header.get('unique_request_id'))].Id);
        }
    }

    @IsTest
    static void serverRejectionIsRecordedWithoutAReference() {
        System.runAs(tester()) {
            ContentVersion staged = stagedFile();
            FileNetCalloutMock mock = new FileNetCalloutMock();
            mock.commitStatus = 413;
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            FileNetDocumentService.Outcome result = FileNetDocumentService.upload(clientId(), staged.Id, 'Application', false);
            Test.stopTest();

            Assert.areEqual('Rejected by server', result.status);
            Assert.areEqual(413, result.httpStatus.intValue());
            Assert.isTrue(result.detail.contains('CONTENT_TOO_LARGE'), result.detail);
            Assert.areEqual(0, [SELECT COUNT() FROM IdentityDocument]);
            Assert.areEqual(0, [SELECT COUNT() FROM ContentDocument WHERE Id = :staged.ContentDocumentId]);
        }
    }

    @IsTest
    static void salesforceLimitOnTheUploadIsRecorded() {
        System.runAs(tester()) {
            ContentVersion staged = stagedFile();
            FileNetCalloutMock mock = new FileNetCalloutMock();
            mock.uploadCalloutError = 'Exceeded max size limit of 10000000 with request size 10000001';
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            FileNetDocumentService.Outcome result = FileNetDocumentService.upload(clientId(), staged.Id, 'Application', false);
            Test.stopTest();

            Assert.areEqual('Salesforce limit', result.status);
            Assert.isTrue(result.detail.contains('Exceeded max size limit'), result.detail);
            Assert.areEqual(0, [SELECT COUNT() FROM IdentityDocument]);
            Assert.areEqual(0, [SELECT COUNT() FROM ContentDocument WHERE Id = :staged.ContentDocumentId]);
        }
    }

    @IsTest
    static void singleRequestAddDocumentMatchesFileNetsApi() {
        FileNetCalloutMock mock = new FileNetCalloutMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        FileNetClient.AddResult added = FileNetClient.addDocument(
            'Client_Document', 'Application form.pdf', 'Application', EncodingUtil.base64Encode(Blob.valueOf('%PDF-1.4 test'))
        );
        Test.stopTest();

        Assert.areEqual(FileNetCalloutMock.DOCUMENT_ID, added.documentId);
        HttpRequest add = mock.requests[1];
        Assert.isTrue(add.getEndpoint().startsWith('callout:FileNet_CM/v1/document/add?nonce='));
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(add.getBody());
        Assert.isTrue(body.containsKey('client_header'));
    }

    @IsTest
    static void asynchronousUploadRunsInAQueueable() {
        System.runAs(tester()) {
            ContentVersion staged = stagedFile();
            Test.setMock(HttpCalloutMock.class, new FileNetCalloutMock());

            Test.startTest();
            FileNetDocumentService.Outcome queued = FileNetDocumentService.upload(clientId(), staged.Id, 'Application', true);
            Assert.areEqual('Running', queued.status);
            Test.stopTest();

            FileNet_Test__c test = [SELECT Status__c, Mode__c, FileNet_Document_Id__c FROM FileNet_Test__c WHERE Id = :queued.testId];
            Assert.areEqual('Stored', test.Status__c);
            Assert.areEqual('Asynchronous', test.Mode__c);
            Assert.areEqual(FileNetCalloutMock.DOCUMENT_ID, test.FileNet_Document_Id__c);
        }
    }

    @IsTest
    static void viewReturnsTheContent() {
        System.runAs(tester()) {
            IdentityDocument document = new IdentityDocument(
                Name = 'Application form.pdf',
                RelatedLegalEntityId = clientId(),
                FileNet_Document_Id__c = FileNetCalloutMock.DOCUMENT_ID
            );
            insert document;
            FileNetCalloutMock mock = new FileNetCalloutMock();
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            FileNetDocumentService.Outcome result = FileNetDocumentService.view(document.Id);
            Test.stopTest();

            Assert.areEqual('Retrieved', result.status, result.detail ?? 'no detail');
            Assert.areEqual(mock.content, result.base64);
            Assert.areEqual('application/pdf', result.mimeType);
            Assert.areEqual(13, result.fileBytes.intValue());
        }
    }

    @IsTest
    static void viewRefusesADocumentTheUserCannotSee() {
        System.runAs(tester()) {
            try {
                FileNetDocumentService.view(clientId());
                Assert.fail('Expected an error');
            } catch (AuraHandledException e) {
                Assert.areEqual('This document isn\'t available to you.', e.getMessage());
            }
        }
    }

    @IsTest
    static void syntheticDocumentPointsAtAGeneratedFile() {
        System.runAs(tester()) {
            Id documentId = FileNetDocumentService.createSyntheticDocument(clientId(), 5);
            IdentityDocument document = [SELECT FileNet_Document_Id__c, File_Size__c FROM IdentityDocument WHERE Id = :documentId];
            Assert.isTrue(document.FileNet_Document_Id__c.startsWith('{SYNTHETIC-5242880-'), document.FileNet_Document_Id__c);
            Assert.areEqual(5242880, document.File_Size__c.intValue());
            Assert.areEqual(1, FileNetDocumentService.clientDocuments(clientId()).size());
        }
    }

    @IsTest
    static void failureReportedByTheComponentIsRecorded() {
        System.runAs(tester()) {
            ContentVersion staged = stagedFile();
            Id testId = FileNetDocumentService.recordFailure(
                'Upload', clientId(), staged.Id, 'Application form.pdf', 'Apex heap size too large: 10500000'
            );
            FileNet_Test__c test = [SELECT Status__c, File_Bytes__c FROM FileNet_Test__c WHERE Id = :testId];
            Assert.areEqual('Salesforce limit', test.Status__c);
            Assert.areEqual(13, test.File_Bytes__c.intValue());
            Assert.areEqual(0, [SELECT COUNT() FROM ContentDocument WHERE Id = :staged.ContentDocumentId]);
            Assert.areEqual(1, FileNetDocumentService.recentTests().size());
        }
    }

    private class HeapLimitedJob implements FinalizerContext {
        public Id getAsyncApexJobId() {
            return null;
        }
        public Exception getException() {
            return new FileNetClient.FileNetException('Apex heap size too large: 26214500');
        }
        public String getRequestId() {
            return null;
        }
        public ParentJobResult getResult() {
            return ParentJobResult.UNHANDLED_EXCEPTION;
        }
    }

    @IsTest
    static void finalizerRecordsAJobThatHitALimit() {
        System.runAs(tester()) {
            ContentVersion staged = stagedFile();
            FileNet_Test__c test = new FileNet_Test__c(Operation__c = 'Upload', Mode__c = 'Asynchronous', Status__c = 'Running');
            insert test;

            new FileNetUploadFinalizer(test.Id, staged.Id).execute(new HeapLimitedJob());

            test = [SELECT Status__c, Detail__c FROM FileNet_Test__c WHERE Id = :test.Id];
            Assert.areEqual('Salesforce limit', test.Status__c);
            Assert.isTrue(test.Detail__c.contains('heap'), test.Detail__c);
            Assert.areEqual(0, [SELECT COUNT() FROM ContentDocument WHERE Id = :staged.ContentDocumentId]);
        }
    }

    @IsTest
    static void statusDistinguishesSalesforceLimitsFromServerRejections() {
        Assert.areEqual('Rejected by server', FileNetDocumentService.statusFor(413, 'HTTP 413'));
        Assert.areEqual('Salesforce limit', FileNetDocumentService.statusFor(null, 'Exceeded max size limit of 6000000'));
        Assert.areEqual('Salesforce limit', FileNetDocumentService.statusFor(null, 'Apex CPU time limit exceeded'));
        Assert.areEqual('Failed', FileNetDocumentService.statusFor(500, 'HTTP 500'));
    }
}
