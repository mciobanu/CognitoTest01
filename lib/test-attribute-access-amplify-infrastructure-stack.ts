import * as cdk from "@aws-cdk/core";
import * as codecommit from "@aws-cdk/aws-codecommit";
import * as amplify from "@aws-cdk/aws-amplify";
import * as cognito from "@aws-cdk/aws-cognito";
import * as iam from "@aws-cdk/aws-iam";
import * as s3 from "@aws-cdk/aws-s3";

/*

Example of controlling access to an S3 bucket via custom attributes in an AWS Amplify app that uses a
Cognito User Pool for authentication. (Amplify is not aware of the S3 bucket, which is created separately.)

Based on https://docs.aws.amazon.com/cognito/latest/developerguide/using-afac-with-cognito-identity-pools.html

After install, there is a manual step required to do the attribute mapping: Go to the identity pool, click on
"Edit identity pool", expand "Authentication providers", under "Attributes for access control" select "Use custom mapping",
and add "client" as "Tag key for principal" and "custom:client" as "Attribute name". Save, and this should be it.

Note: the actual Amplify web app is a separate thing, and it's not published (yet) as it's unclear if there's a point in publishing it.
It has a customized sign-up screen to allow more fields to be added, and writes to S3 when pressing a button.
The extra fields are "givenName", "familyName", and "client". The latter is the custom field that is used for access control.

 */

export class TestAttributeAccessAmplifyInfrastructureStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const userPool = new cognito.UserPool(this, "TestAttributeAccessUserPool", {
            selfSignUpEnabled: true, // Allow users to sign up
            autoVerify: {email: true}, // Verify email addresses by sending a verification code
            signInAliases: {email: true}, // Set email as an alias
            customAttributes: {
                client: new cognito.StringAttribute({minLen: 3, maxLen: 60}), // It doesn't make much sense to let the user specify this field
                // at sign up, as it would grant access to an S3 folder of the user's choosing. However, this is just an example.
            },
            standardAttributes: { // also https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html
                givenName: {
                    required: true,
                    mutable: true,
                },
                familyName: {
                    required: true,
                    mutable: true,
                },
            },
        });

        const userPoolClient = new cognito.UserPoolClient(this, "TestAttributeAccessUserPoolClient", {
            userPool,
            generateSecret: false, // Don't need to generate secret for web app running on browsers
        });

        const identityPool = new cognito.CfnIdentityPool(this, "TestAttributeAccessIdentityPool", {
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [{
                clientId: userPoolClient.userPoolClientId,
                providerName: userPool.userPoolProviderName,
                // This is where mapping the attributes should happen, at the provider level, but nothing in CDK / CloudFormation seems
                // able to do this
            }],
        });

        const repositoryArn = 'arn:aws:codecommit:repo-arn'; //!!! an actual CodeCommit repository ARN is needed here
        const amplifyReactRepo = codecommit.Repository.fromRepositoryArn(
                this, 'TestAttributeAccessAmplifyReactApp', repositoryArn);

        const bucket = new s3.Bucket(this, 'TestAttributeAccessBucket', {
            versioned: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            cors: [
                {
                    allowedMethods: [
                        s3.HttpMethods.GET,
                        s3.HttpMethods.POST,
                        s3.HttpMethods.PUT,
                    ],
                    allowedOrigins: ['*'],
                    allowedHeaders: ['*'],
                },
            ],
        });

        const amplifyApp = new amplify.App(this, "TestAttributeAccessAmplifyReact", {
            sourceCodeProvider: new amplify.CodeCommitSourceCodeProvider({
                repository: amplifyReactRepo,
            }),
            environmentVariables: {
                'IDENTITY_POOL_ID': identityPool.ref,
                'USER_POOL_ID': userPool.userPoolId,
                'USER_POOL_CLIENT_ID': userPoolClient.userPoolClientId,
                'REGION': this.region,
                'BUCKET': bucket.bucketName,
            },
        });
        const mainBranch = amplifyApp.addBranch("main");

        this.createRoles(bucket, identityPool, userPool, userPoolClient);
    }

    private createRoles(bucket: s3.Bucket, identityPool: cognito.CfnIdentityPool, userPool: cognito.UserPool, userPoolClient: cognito.UserPoolClient) {

        const s3AccessPolicy = new iam.ManagedPolicy(this, 's3ManagedPolicy', {
            description: 'Allows S3 access',
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:ListBucket',],
                    resources: [bucket.bucketArn],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:GetObject*', 's3:PutObject*',],
                    resources: [bucket.bucketArn + '/${aws:PrincipalTag/client}/*'],
                }),
            ],
        });

        const authenticatedRole = new iam.CfnRole(this, 'identityPoolAuthenticatedRole', {
            assumeRolePolicyDocument: {
                'Statement': [{
                    'Effect': iam.Effect.ALLOW,
                    'Action': ['sts:AssumeRoleWithWebIdentity', 'sts:TagSession'],
                    'Condition': {
                        'StringEquals': {
                            'cognito-identity.amazonaws.com:aud': identityPool.getAtt('Ref')
                        },
                        'ForAnyValue:StringLike': {
                            'cognito-identity.amazonaws.com:amr': 'authenticated'
                        }
                    },
                    'Principal': {
                        'Federated': 'cognito-identity.amazonaws.com'
                    }
                }]
            },
            description: 'Default role for authenticated users',
            managedPolicyArns: [
                s3AccessPolicy.managedPolicyArn,
            ],
        });

        //!!! Even if we don't allow unauthenticated access, we specify a role to avoid warnings in the console
        const unauthenticatedRole = new iam.CfnRole(this, 'identityPoolUnauthenticatedRole', {
            assumeRolePolicyDocument: {
                'Statement': [{
                    'Effect': iam.Effect.ALLOW,
                    'Action': ['sts:AssumeRoleWithWebIdentity', 'sts:TagSession'],
                    'Condition': {
                        'StringEquals': {
                            'cognito-identity.amazonaws.com:aud': identityPool.getAtt('Ref')
                        },
                        'ForAnyValue:StringLike': {
                            'cognito-identity.amazonaws.com:amr': 'unauthenticated'
                        }
                    },
                    'Principal': {
                        'Federated': 'cognito-identity.amazonaws.com'
                    }
                }]
            },
            description: 'Default role for unauthenticated users',
        });

        new cognito.CfnIdentityPoolRoleAttachment(
                this,
                'identity-pool-role-attachment',
                {
                    identityPoolId: identityPool.ref,
                    roles: {
                        authenticated: authenticatedRole.attrArn,
                        unauthenticated: unauthenticatedRole.attrArn,
                    },
                    roleMappings: {
                        mapping: {
                            type: 'Token',
                            ambiguousRoleResolution: 'AuthenticatedRole',
                            identityProvider: `cognito-idp.${
                                    cdk.Stack.of(this).region
                            }.amazonaws.com/${userPool.userPoolId}:${
                                    userPoolClient.userPoolClientId
                            }`,
                        },
                    },
                },
        );
    }
}
