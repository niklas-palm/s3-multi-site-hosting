import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class DnsStack extends cdk.Stack {
  public readonly hostedZone: route53.HostedZone;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = 'hosting.nipalm.com';

    // Route53 Hosted Zone
    this.hostedZone = new route53.HostedZone(this, 'HostingZone', {
      zoneName: domainName,
    });

    // Outputs
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Route53 hosted zone ID',
    });

    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join('\n', this.hostedZone.hostedZoneNameServers || []),
      description: 'Add these NS records to your parent nipalm.com zone',
    });
  }
}
