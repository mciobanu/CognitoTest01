Example of controlling access to an S3 bucket via custom attributes in an AWS Amplify app that uses a
Cognito User Pool for authentication. (Amplify is not aware of the S3 bucket, which is created separately.)

Based on https://docs.aws.amazon.com/cognito/latest/developerguide/using-afac-with-cognito-identity-pools.html

After install, there is a manual step required to do the attribute mapping: Go to the identity pool, click on
"Edit identity pool", expand "Authentication providers", under "Attributes for access control" select "Use custom mapping",
and add "client" as "Tag key for principal" and "custom:client" as "Attribute name". Save, and this should be it.

Note: the actual Amplify web app is a separate thing, and it's not published (yet) as it's unclear if there's a point in publishing it.
It has a customized sign-up screen to allow more fields to be added, and writes to S3 when pressing a button.
The extra fields are "givenName", "familyName", and "client". The latter is the custom field that is used for access control.
