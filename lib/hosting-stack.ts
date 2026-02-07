import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

export interface HostingStackProps extends cdk.StackProps {
  authEdgeFunction: cloudfront.experimental.EdgeFunction;
  certificate: acm.ICertificate;
  hostedZone: route53.IHostedZone;
}

export class HostingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);

    const domainName = 'hosting.nipalm.com';
    const wildcardDomain = `*.${domainName}`;

    // S3 Bucket for hosting static sites
    const bucket = new s3.Bucket(this, 'HostingSitesBucket', {
      bucketName: 'hosting-nipalm-sites',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Security headers response policy
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true,
        },
      },
    });

    // CloudFront Distribution with Lambda@Edge for auth + routing
    const distribution = new cloudfront.Distribution(this, 'HostingDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        edgeLambdas: [{
          functionVersion: props.authEdgeFunction.currentVersion,
          eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
        }],
        responseHeadersPolicy,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [wildcardDomain, domainName],
      certificate: props.certificate,  // From auth stack (us-east-1)
      enableIpv6: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/_errors/404.html',
          ttl: cdk.Duration.seconds(60),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/_errors/404.html',
          ttl: cdk.Duration.seconds(60),
        },
      ],
    });

    // Route53 A record (wildcard)
    new route53.ARecord(this, 'WildcardARecord', {
      zone: props.hostedZone,
      recordName: '*',
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // Route53 AAAA record (wildcard, IPv6)
    new route53.AaaaRecord(this, 'WildcardAAAARecord', {
      zone: props.hostedZone,
      recordName: '*',
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // Route53 A record (apex)
    new route53.ARecord(this, 'ApexARecord', {
      zone: props.hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // Route53 AAAA record (apex, IPv6)
    new route53.AaaaRecord(this, 'ApexAAAARecord', {
      zone: props.hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // Deploy error pages to S3
    new s3deploy.BucketDeployment(this, 'DeployErrorPages', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../_errors'))],
      destinationBucket: bucket,
      destinationKeyPrefix: '_errors',
    });

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket for hosting sites',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain',
    });
  }
}
