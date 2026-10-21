// A heap or CPU limit ends the job without running its own error handling, so the finalizer records it.
public with sharing class FileNetUploadFinalizer implements Finalizer {

    private final Id testId;
    private final Id contentVersionId;

    public FileNetUploadFinalizer(Id testId, Id contentVersionId) {
        this.testId = testId;
        this.contentVersionId = contentVersionId;
    }

    public void execute(FinalizerContext context) {
        if (context.getResult() == ParentJobResult.SUCCESS) {
            return;
        }
        Exception failure = context.getException();
        String message = failure == null
            ? 'The upload job failed.'
            : failure.getTypeName() + ': ' + failure.getMessage();
        update new FileNet_Test__c(
            Id = testId,
            Status__c = FileNetDocumentService.statusFor(null, message),
            Detail__c = message.left(32000)
        );
        FileNetDocumentService.removeStagedVersion(contentVersionId);
    }
}
