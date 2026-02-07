import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import * as path from 'path';

export interface AuthStackProps extends cdk.StackProps {
  domainPrefix: string;
  hostedZone: route53.IHostedZone;
}

export class AuthStack extends cdk.Stack {
  public readonly edgeFunction: cloudfront.experimental.EdgeFunction;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const ssmParamName = '/hosting-nipalm/auth-config';
    const domainName = 'hosting.nipalm.com';
    const wildcardDomain = `*.${domainName}`;

    // Use apex domain for OAuth callback (wildcards don't work reliably in Cognito)
    const callbackUrl = `https://${domainName}/_auth/callback`;

    // ACM Certificate - MUST be in us-east-1 for CloudFront
    this.certificate = new acm.Certificate(this, 'HostingCertificate', {
      domainName: wildcardDomain,
      subjectAlternativeNames: [domainName],
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'HostingUserPool', {
      userPoolName: 'hosting-nipalm-users',
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Cognito Domain with Managed Login v2
    const cognitoDomain = this.userPool.addDomain('HostingCognitoDomain', {
      cognitoDomain: {
        domainPrefix: props.domainPrefix,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // User Pool Client
    this.userPoolClient = this.userPool.addClient('HostingAppClient', {
      userPoolClientName: 'hosting-web-client',
      generateSecret: true,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
        ],
        // Single callback URL - wildcards don't work in Cognito
        callbackUrls: [callbackUrl],
        logoutUrls: [`https://${domainName}/`],
      },
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });

    // Enable Managed Login v2 branding
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // Get the client secret using a custom resource
    const describeClientSecret = new cr.AwsCustomResource(this, 'DescribeClientSecret', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'describeUserPoolClient',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          ClientId: this.userPoolClient.userPoolClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of('ClientSecret'),
      },
      onUpdate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'describeUserPoolClient',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          ClientId: this.userPoolClient.userPoolClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of('ClientSecret'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.userPool.userPoolArn],
      }),
    });

    const clientSecret = describeClientSecret.getResponseField('UserPoolClient.ClientSecret');

    // Create SSM parameter with Cognito config
    const authConfigParam = new ssm.StringParameter(this, 'AuthConfigParam', {
      parameterName: ssmParamName,
      stringValue: JSON.stringify({
        cognitoDomain: `${props.domainPrefix}.auth.us-east-1.amazoncognito.com`,
        clientId: this.userPoolClient.userPoolClientId,
        clientSecret: clientSecret,
        cognitoRegion: 'us-east-1',
        userPoolId: this.userPool.userPoolId,
        callbackUrl: callbackUrl,  // Fixed callback URL
      }),
      tier: ssm.ParameterTier.STANDARD,
    });

    // Lambda@Edge function
    this.edgeFunction = new cloudfront.experimental.EdgeFunction(this, 'AuthCheckFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'functions/auth-check'), {
        bundling: {
          local: {
            tryBundle(outputDir: string): boolean {
              const { execSync } = require('child_process');
              const sourceDir = path.join(__dirname, 'functions/auth-check');
              try {
                execSync(`cd ${sourceDir} && npm install && npx esbuild index.ts --bundle --platform=node --target=node20 --outfile=${outputDir}/index.js --format=cjs`, {
                  stdio: 'inherit',
                });
                return true;
              } catch (e) {
                console.error('Local bundling failed:', e);
                return false;
              }
            },
          },
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm install && npx esbuild index.ts --bundle --platform=node --target=node20 --outfile=/asset-output/index.js --format=cjs',
          ],
        },
      }),
      timeout: cdk.Duration.seconds(4),
      memorySize: 256,
    });

    // Grant Lambda@Edge permission to read from SSM
    authConfigParam.grantRead(this.edgeFunction);
    this.edgeFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:*:${this.account}:parameter${ssmParamName}`],
    }));

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
    });

    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: cognitoDomain.baseUrl(),
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
    });
  }
}
