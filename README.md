# Multi-Tenant Static Hosting Platform

Zero-config static website hosting with shared Cognito authentication.

**Domain:** `*.hosting.nipalm.com`

## Architecture

```
User → CloudFront → Lambda@Edge (auth + routing) → S3 (/{subdomain}/...)
              ↓
        Cognito Managed Login (if not authenticated)
```

Upload files to `s3://hosting-nipalm-sites/myapp/` → `https://myapp.hosting.nipalm.com` works automatically.

## Stacks

| Stack | Region | Resources |
|-------|--------|-----------|
| `HostingDnsStack` | us-east-1 | Route53 hosted zone |
| `HostingAuthStack` | us-east-1 | ACM certificate, Cognito, Lambda@Edge |
| `HostingNipalmStack` | Your region | S3 bucket, CloudFront, DNS records |

## Deployment

### Phase 1: Deploy DNS

```bash
npx cdk deploy HostingDnsStack
```

Copy the NS records from the output.

### Phase 2: Configure Parent Zone

Add NS records to your `nipalm.com` zone:

```
hosting.nipalm.com  NS  ns-xxx.awsdns-xx.org
hosting.nipalm.com  NS  ns-xxx.awsdns-xx.co.uk
hosting.nipalm.com  NS  ns-xxx.awsdns-xx.com
hosting.nipalm.com  NS  ns-xxx.awsdns-xx.net
```

Wait for DNS propagation. Verify:
```bash
dig NS hosting.nipalm.com
```

### Phase 3: Deploy Auth & Hosting

```bash
npx cdk deploy HostingAuthStack HostingNipalmStack
```

## Operations

### Get Resource IDs

```bash
# User Pool ID
aws cognito-idp list-user-pools --max-results 10 --region us-east-1 \
  --query "UserPools[?Name=='hosting-nipalm-users'].Id" --output text

# CloudFront Distribution ID
aws cloudformation describe-stacks --stack-name HostingNipalmStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text
```

### Create a User

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com \
  --region us-east-1
```

### Deploy a Site

```bash
aws s3 sync ./dist s3://hosting-nipalm-sites/myapp/ --delete
```

Site available at: `https://myapp.hosting.nipalm.com`

### Invalidate Cache

```bash
aws cloudfront create-invalidation \
  --distribution-id <DistributionId> \
  --paths "/myapp/*"
```

### Remove a Site

```bash
aws s3 rm s3://hosting-nipalm-sites/myapp/ --recursive
```

### List Users

```bash
aws cognito-idp list-users --user-pool-id <UserPoolId> --region us-east-1
```

### Delete a User

```bash
aws cognito-idp admin-delete-user \
  --user-pool-id <UserPoolId> \
  --username user@example.com \
  --region us-east-1
```

## Authentication

- All sites require authentication (shared across subdomains)
- Users sign in via Cognito Managed Login v2
- Session stored in secure HttpOnly cookie (1 hour)
- Self-signup disabled (admin creates users)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Certificate stuck validating | Ensure NS records are configured in parent zone |
| 403 on new subdomain | Upload files to the subdomain folder in S3 |
| Auth redirect loop | Check Lambda@Edge logs in CloudWatch (us-east-1) |
| Old content showing | Create CloudFront cache invalidation |

## Costs (~$15/month for moderate usage)

- S3: ~$3/month (storage + requests)
- CloudFront: ~$10/month (data transfer + requests)
- Route53: $0.50/month (hosted zone)
- Cognito: Free tier (50k MAU)
- Lambda@Edge: ~$0.10/month
