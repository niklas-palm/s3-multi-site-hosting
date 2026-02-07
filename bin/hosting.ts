#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DnsStack } from '../lib/dns-stack';
import { AuthStack } from '../lib/auth-stack';
import { HostingStack } from '../lib/hosting-stack';

const app = new cdk.App();

// Phase 1: DNS Stack - Creates hosted zone
// Deploy this first, then add NS records to parent zone before proceeding
const dnsStack = new DnsStack(app, 'HostingDnsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',  // Route53 is global, but keep with auth for simplicity
  },
});

// Phase 2: Auth Stack - Certificate, Cognito, Lambda@Edge
// Only deploy after NS records are configured (certificate validation needs DNS)
const authStack = new AuthStack(app, 'HostingAuthStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',  // Required for Lambda@Edge and ACM
  },
  domainPrefix: 'hosting-nipalm-auth',
  hostedZone: dnsStack.hostedZone,
  crossRegionReferences: true,
});
authStack.addDependency(dnsStack);

// Phase 3: Hosting Stack - S3, CloudFront, DNS records
const hostingStack = new HostingStack(app, 'HostingNipalmStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  authEdgeFunction: authStack.edgeFunction,
  certificate: authStack.certificate,
  hostedZone: dnsStack.hostedZone,
  crossRegionReferences: true,
});
hostingStack.addDependency(authStack);
