#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib';
import { HostingStack } from '../lib/hosting-stack';

const app = new cdk.App();

new HostingStack(app, 'S3MultiSiteHostingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
});
