# S3 Multi-Site Hosting

Host unlimited static websites from a single S3 bucket with automatic subdomain routing.

```
myapp.yourdomain.com  ──┐
blog.yourdomain.com   ──┼──▶  CloudFront  ──▶  S3 Bucket
docs.yourdomain.com   ──┘                      ├── myapp/
                                               ├── blog/
                                               └── docs/
```

Upload files to `s3://bucket/myapp/` and `https://myapp.yourdomain.com` works automatically.

## Features

- **Wildcard subdomains** — any `*.yourdomain.com` routes to matching S3 prefix
- **Zero-config SSL** — wildcard certificate created automatically
- **Global CDN** — CloudFront with HTTP/2, HTTP/3, IPv6
- **Aggressive caching** — 7-day default TTL with Gzip + Brotli compression
- **Security headers** — HSTS, X-Frame-Options, XSS protection

## Prerequisites

- AWS account with [CDK bootstrapped](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) in `us-east-1`
- Route53 hosted zone for your domain

## Quick Start

### 1. Configure

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `DOMAIN_NAME` | Your domain (e.g., `example.com`) |
| `HOSTED_ZONE_ID` | Route53 hosted zone ID |

### 2. Deploy Infrastructure

```bash
npm install
npx cdk deploy
```

First deployment takes ~5 minutes (certificate validation).

### 3. Note Your Outputs

After deployment, save these values:

```bash
aws cloudformation describe-stacks \
  --stack-name S3MultiSiteHostingStack \
  --query "Stacks[0].Outputs" \
  --output table \
  --region us-east-1
```

You'll need `BucketName` and `DistributionId` for deployments.

---

## Deploying Sites

### Manual Deployment

```bash
# Build your project
npm run build

# Upload to S3 (replace <bucket> and <subdomain>)
aws s3 sync ./dist s3://<bucket>/<subdomain>/ --delete --region us-east-1

# Invalidate cache
aws cloudfront create-invalidation \
  --distribution-id <DistributionId> \
  --paths "/<subdomain>/*" \
  --region us-east-1
```

Your site is live at `https://<subdomain>.yourdomain.com`

### AI-Assisted Deployment

A deployment skill is included for AI coding assistants. It automates building, uploading, cache invalidation, and tracks deployment state.

#### Install the Skill

**Claude Code:**
```bash
unzip deploy-to-s3.skill -d ~/.claude/skills/deploy-to-s3
```

**Kiro:**
```bash
unzip deploy-to-s3.skill -d ~/.kiro/skills/deploy-to-s3
```

#### Configure the Skill

Edit the `SKILL.md` file in the installed location and update:

```yaml
ACCOUNT_ID: <your-aws-account-id>
BUCKET_NAME: <from-stack-output>
DISTRIBUTION_ID: <from-stack-output>
DOMAIN: yourdomain.com
REGION: us-east-1
AWS_PROFILE: (optional - leave empty to use shell credentials)
```

#### Usage

From any React SPA project, just say:

| Command | Action |
|---------|--------|
| "deploy this to myapp.example.com" | Deploy to specific subdomain |
| "deploy to s3" | Deploy (uses existing config or asks) |
| "delete this deployment" | Remove site from S3 |

The skill will:
1. Verify AWS credentials match the configured account
2. Validate the project is a static React SPA (no SSR)
3. Check subdomain availability
4. Build and sync to S3
5. Invalidate CloudFront cache
6. Create/update `DEPLOYMENT.md` to track state

---

## URL Routing

| Request URL | S3 Object |
|-------------|-----------|
| `myapp.example.com/` | `myapp/index.html` |
| `myapp.example.com/about` | `myapp/about/index.html` |
| `myapp.example.com/app.js` | `myapp/app.js` |

**Note:** Only subdomains work. The apex domain (`example.com`) returns 404.

## Caching

Default TTL is 7 days. Always invalidate after deploying:

```bash
# Invalidate one site
aws cloudfront create-invalidation \
  --distribution-id <ID> \
  --paths "/myapp/*"

# Invalidate everything
aws cloudfront create-invalidation \
  --distribution-id <ID> \
  --paths "/*"
```

## Remove a Site

```bash
aws s3 rm s3://<bucket>/<subdomain>/ --recursive --region us-east-1
```

## Certificate

The stack creates a wildcard certificate for `*.yourdomain.com` only. The apex domain is not included and will not work with HTTPS.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Route53                                 │
│                    *.example.com → CloudFront                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                       CloudFront                                │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  CloudFront Function (viewer-request)                  │     │
│  │  • Extract subdomain from Host header                  │     │
│  │  • Rewrite URI: /path → /subdomain/path                │     │
│  │  • Validate subdomain format                           │     │
│  └────────────────────────────────────────────────────────┘     │
│  • Wildcard SSL certificate (*.example.com)                     │
│  • HTTP/2 + HTTP/3, IPv6 enabled                                │
│  • Gzip + Brotli compression                                    │
│  • Security headers (HSTS, X-Frame-Options, etc.)               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                        S3 Bucket                                │
│  ├── myapp/                                                     │
│  │   ├── index.html                                             │
│  │   └── assets/                                                │
│  ├── blog/                                                      │
│  │   └── index.html                                             │
│  └── _errors/                                                   │
│      └── 404.html                                               │
└─────────────────────────────────────────────────────────────────┘
```

## Stack Outputs

| Output | Description |
|--------|-------------|
| `BucketName` | S3 bucket for uploading sites |
| `DistributionId` | CloudFront distribution (for cache invalidation) |
| `DistributionDomain` | CloudFront domain name |

## License

MIT
