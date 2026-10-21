public with sharing class FileNetDocumentService {

    @TestVisible
    private static final String DOC_CLASS = 'Client_Document';
    private static final Integer DETAIL_LENGTH = 32000;

    private static final Map<String, String> MIME_TYPES = new Map<String, String>{
        'csv' => 'text/csv',
        'doc' => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'gif' => 'image/gif',
        'jpeg' => 'image/jpeg',
        'jpg' => 'image/jpeg',
        'pdf' => 'application/pdf',
        'png' => 'image/png',
        'tif' => 'image/tiff',
        'tiff' => 'image/tiff',
        'txt' => 'text/plain',
        'xls' => 'application/vnd.ms-excel',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };

    public class Outcome {
        @AuraEnabled public Id testId;
        @AuraEnabled public String status;
        @AuraEnabled public String detail;
        @AuraEnabled public String fileName;
        @AuraEnabled public Decimal fileBytes;
        @AuraEnabled public Decimal bodyBytes;
        @AuraEnabled public Decimal heapBytes;
        @AuraEnabled public Decimal heapLimitBytes;
        @AuraEnabled public Decimal elapsedMs;
        @AuraEnabled public Decimal httpStatus;
        @AuraEnabled public String documentId;
        @AuraEnabled public String mimeType;
        @AuraEnabled public String base64;
    }

    @AuraEnabled
    public static Outcome upload(Id clientId, Id contentVersionId, String documentType, Boolean runAsync) {
        ContentVersion version = stagedVersion(contentVersionId);
        Boolean async = runAsync == true;
        FileNet_Test__c test = newTest('Upload', async ? 'Asynchronous' : 'Synchronous', clientId, fileNameOf(version), version.ContentSize);
        if (async) {
            test.Status__c = 'Running';
            insert test;
            System.enqueueJob(new FileNetUploadJob(test.Id, clientId, contentVersionId, documentType));
            return outcome(test);
        }
        runUpload(test, clientId, version, documentType);
        insert test;
        return outcome(test);
    }

    // Shared by the synchronous path and FileNetUploadJob. Callouts come before any DML.
    public static void runUpload(FileNet_Test__c test, Id clientId, ContentVersion version, String documentType) {
        test.Heap_Limit_Bytes__c = Limits.getLimitHeapSize();
        try {
            FileNetClient.AddResult added = FileNetClient.addDocumentDirect(
                DOC_CLASS, test.File_Name__c, documentType, encodedContent(version.Id)
            );
            record(test, added.call);
            Database.insert(new IdentityDocument(
                Name = test.File_Name__c.left(255),
                RelatedLegalEntityId = clientId,
                FileNet_Document_Id__c = added.documentId,
                FileNet_Document_Class__c = DOC_CLASS,
                Mime_Type__c = mimeTypeOf(test.File_Name__c),
                File_Size__c = version.ContentSize
            ), AccessLevel.USER_MODE);
            test.FileNet_Document_Id__c = added.documentId;
            test.Status__c = 'Stored';
            test.Detail__c = added.detail;
        } catch (FileNetClient.FileNetException e) {
            record(test, e.call);
            test.Status__c = statusFor(e.call.statusCode, e.getMessage());
            test.Detail__c = e.getMessage().left(DETAIL_LENGTH);
        } finally {
            removeStaged(version.ContentDocumentId);
        }
    }

    @AuraEnabled
    public static Outcome view(Id clientDocumentId) {
        IdentityDocument document = accessibleDocument(clientDocumentId);
        FileNet_Test__c test = newTest('View', 'Synchronous', document.RelatedLegalEntityId, document.Name, document.File_Size__c);
        test.FileNet_Document_Id__c = document.FileNet_Document_Id__c;
        test.Heap_Limit_Bytes__c = Limits.getLimitHeapSize();
        FileNetClient.ContentResult content;
        try {
            content = FileNetClient.getContent(document.FileNet_Document_Id__c);
            record(test, content.call);
            test.File_Bytes__c = decodedSize(content.base64);
            test.Status__c = 'Retrieved';
        } catch (FileNetClient.FileNetException e) {
            record(test, e.call);
            test.Status__c = statusFor(e.call.statusCode, e.getMessage());
            test.Detail__c = e.getMessage().left(DETAIL_LENGTH);
        }
        insert test;

        Outcome result = outcome(test);
        if (content != null) {
            result.fileName = String.isBlank(content.fileName) ? document.Name : content.fileName;
            result.mimeType = content.mimeType;
            result.base64 = content.base64;
        }
        return result;
    }

    // Points a Client Document at a generated PDF of the given size, so view can be
    // tested above what an upload through Vercel allows.
    @AuraEnabled
    public static Id createSyntheticDocument(Id clientId, Decimal megabytes) {
        if (megabytes == null || megabytes < 0.01 || megabytes > 50) {
            throw userError('Choose a size from 0.01 to 50 MB.');
        }
        Long bytes = (megabytes * 1024 * 1024).round(System.RoundingMode.HALF_UP);
        String suffix = EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(8).toUpperCase();
        IdentityDocument document = new IdentityDocument(
            Name = 'Synthetic ' + megabytes.setScale(2) + ' MB.pdf',
            RelatedLegalEntityId = clientId,
            FileNet_Document_Id__c = '{SYNTHETIC-' + bytes + '-' + suffix + '}',
            FileNet_Document_Class__c = 'Synthetic',
            Mime_Type__c = 'application/pdf',
            File_Size__c = bytes
        );
        Database.insert(document, AccessLevel.USER_MODE);
        return document.Id;
    }

    // A heap or CPU limit ends the transaction before it can log itself, so the component reports it.
    @AuraEnabled
    public static Id recordFailure(String operation, Id clientId, Id contentVersionId, String fileName, String message) {
        Decimal fileBytes;
        if (contentVersionId != null) {
            for (ContentVersion version : [
                SELECT ContentDocumentId, ContentSize FROM ContentVersion WHERE Id = :contentVersionId WITH USER_MODE
            ]) {
                fileBytes = version.ContentSize;
                removeStaged(version.ContentDocumentId);
            }
        }
        FileNet_Test__c test = newTest(operation == 'View' ? 'View' : 'Upload', 'Synchronous', clientId, fileName, fileBytes);
        test.Status__c = statusFor(null, message);
        test.Detail__c = String.isBlank(message) ? null : message.left(DETAIL_LENGTH);
        insert test;
        return test.Id;
    }

    @AuraEnabled
    public static List<FileNet_Test__c> recentTests() {
        return [
            SELECT Id, Name, CreatedDate, Operation__c, Mode__c, Status__c, File_Name__c, File_Bytes__c,
                Body_Bytes__c, Heap_Bytes__c, Heap_Limit_Bytes__c, Callout_Ms__c, Http_Status__c, Detail__c,
                FileNet_Document_Id__c, Request_Id__c
            FROM FileNet_Test__c
            WHERE CreatedById = :UserInfo.getUserId()
            WITH USER_MODE
            ORDER BY CreatedDate DESC, Name DESC
            LIMIT 25
        ];
    }

    @AuraEnabled
    public static List<IdentityDocument> clientDocuments(Id clientId) {
        return [
            SELECT Id, Name, FileNet_Document_Id__c, File_Size__c, Mime_Type__c, CreatedDate
            FROM IdentityDocument
            WHERE RelatedLegalEntityId = :clientId AND FileNet_Document_Id__c != null
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 50
        ];
    }

    public static ContentVersion stagedVersion(Id contentVersionId) {
        return [
            SELECT Id, ContentDocumentId, Title, PathOnClient, FileExtension, ContentSize
            FROM ContentVersion
            WHERE Id = :contentVersionId
            WITH USER_MODE
        ];
    }

    public static void removeStagedVersion(Id contentVersionId) {
        for (ContentVersion version : [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :contentVersionId]) {
            removeStaged(version.ContentDocumentId);
        }
    }

    // Deleted files sit in the Recycle Bin for 15 days unless it is emptied.
    public static void removeStaged(Id contentDocumentId) {
        List<ContentDocument> staged = [SELECT Id FROM ContentDocument WHERE Id = :contentDocumentId];
        if (!staged.isEmpty()) {
            delete staged;
            Database.emptyRecycleBin(staged);
        }
    }

    public static String statusFor(Integer httpStatus, String message) {
        if (httpStatus == 413) {
            return 'Rejected by server';
        }
        String text = message == null ? '' : message.toLowerCase();
        if (text.contains('heap') || text.contains('size limit') || text.contains('cpu time')) {
            return 'Salesforce limit';
        }
        return 'Failed';
    }

    // Returned straight into the call, so the decoded file can be freed before the request body is built.
    private static String encodedContent(Id contentVersionId) {
        return EncodingUtil.base64Encode(
            [SELECT VersionData FROM ContentVersion WHERE Id = :contentVersionId WITH USER_MODE].VersionData
        );
    }

    private static IdentityDocument accessibleDocument(Id clientDocumentId) {
        List<IdentityDocument> documents = [
            SELECT Id, Name, RelatedLegalEntityId, FileNet_Document_Id__c, File_Size__c
            FROM IdentityDocument
            WHERE Id = :clientDocumentId
            WITH USER_MODE
        ];
        if (documents.isEmpty() || String.isBlank(documents[0].FileNet_Document_Id__c)) {
            throw userError('This document isn\'t available to you.');
        }
        return documents[0];
    }

    private static FileNet_Test__c newTest(String operation, String mode, Id clientId, String fileName, Decimal fileBytes) {
        return new FileNet_Test__c(
            Operation__c = operation,
            Mode__c = mode,
            Client__c = clientId != null && clientId.getSObjectType() == Account.SObjectType ? clientId : null,
            File_Name__c = fileName == null ? null : fileName.left(255),
            File_Bytes__c = fileBytes
        );
    }

    private static void record(FileNet_Test__c test, FileNetClient.Call call) {
        if (call == null) {
            return;
        }
        test.Request_Id__c = call.requestId;
        test.Http_Status__c = call.statusCode;
        test.Body_Bytes__c = call.bodyBytes;
        test.Heap_Bytes__c = call.heapBytes;
        test.Callout_Ms__c = call.elapsedMs;
    }

    private static Outcome outcome(FileNet_Test__c test) {
        Outcome result = new Outcome();
        result.testId = test.Id;
        result.status = test.Status__c;
        result.detail = test.Detail__c;
        result.fileName = test.File_Name__c;
        result.fileBytes = test.File_Bytes__c;
        result.bodyBytes = test.Body_Bytes__c;
        result.heapBytes = test.Heap_Bytes__c;
        result.heapLimitBytes = test.Heap_Limit_Bytes__c;
        result.elapsedMs = test.Callout_Ms__c;
        result.httpStatus = test.Http_Status__c;
        result.documentId = test.FileNet_Document_Id__c;
        return result;
    }

    private static String fileNameOf(ContentVersion version) {
        if (String.isNotBlank(version.PathOnClient)) {
            return version.PathOnClient;
        }
        return String.isBlank(version.FileExtension) ? version.Title : version.Title + '.' + version.FileExtension;
    }

    private static String mimeTypeOf(String fileName) {
        String extension = fileName == null ? '' : fileName.substringAfterLast('.').toLowerCase();
        return MIME_TYPES.containsKey(extension) ? MIME_TYPES.get(extension) : 'application/octet-stream';
    }

    private static Decimal decodedSize(String base64) {
        if (base64 == null) {
            return null;
        }
        Integer padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
        return base64.length() / 4 * 3 - padding;
    }

    private static AuraHandledException userError(String message) {
        AuraHandledException error = new AuraHandledException(message);
        error.setMessage(message);
        return error;
    }
}
