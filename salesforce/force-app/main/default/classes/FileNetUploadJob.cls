// Runs an upload with asynchronous Apex limits: 12 MB callout body and a larger heap.
public with sharing class FileNetUploadJob implements Queueable, Database.AllowsCallouts {

    private final Id testId;
    private final Id clientId;
    private final Id contentVersionId;
    private final String documentType;

    public FileNetUploadJob(Id testId, Id clientId, Id contentVersionId, String documentType) {
        this.testId = testId;
        this.clientId = clientId;
        this.contentVersionId = contentVersionId;
        this.documentType = documentType;
    }

    public void execute(QueueableContext context) {
        System.attachFinalizer(new FileNetUploadFinalizer(testId, contentVersionId));
        FileNet_Test__c test = [SELECT Id, File_Name__c FROM FileNet_Test__c WHERE Id = :testId];
        FileNetDocumentService.runUpload(test, clientId, FileNetDocumentService.stagedVersion(contentVersionId), documentType);
        update test;
    }
}
