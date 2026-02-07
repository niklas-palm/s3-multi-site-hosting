# Multi-Tenant Static Website Hosting Platform
## Design Document: S3 + CloudFront with Wildcard Subdomain Routing

**Version:** 1.0  
**Date:** February 2025  
**Domain:** `*.hosting.nipalm.com`

---

## 1. Executive Summary

This document describes a "zero-config" multi-tenant static website hosting solution where deploying a new site requires only uploading files to a folder in S3. The architecture uses:

- **Single S3 bucket** with folder-per-tenant structure
- **Single CloudFront distribution** with wildcard domain support
- **CloudFront Function** to route requests based on subdomain
- **Wildcard SSL certificate** from ACM
- **Wildcard DNS record** in Route53

**Key Benefit:** Upload files to `s3://bucket/myapp/` → `myapp.hosting.nipalm.com` works automatically.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Request Flow                                 │
└─────────────────────────────────────────────────────────────────────┘

User Request: https://myapp.hosting.nipalm.com/dashboard
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Route53 (Wildcard A Record)                                        │
│  *.hosting.nipalm.com → CloudFront Distribution                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CloudFront Distribution                                            │
│  ├── SSL/TLS: ACM Certificate (*.hosting.nipalm.com)               │
│  ├── Alternate Domain: *.hosting.nipalm.com                        │
│  └── Viewer Request: CloudFront Function                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CloudFront Function (Viewer Request)                               │
│  ├── Extract subdomain from Host header                            │
│  ├── Rewrite URI: /dashboard → /myapp/dashboard                    │
│  └── Handle SPA routing: /myapp/dashboard → /myapp/index.html      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  S3 Bucket (Private, OAC-protected)                                 │
│  ├── /myapp/                                                        │
│  │   ├── index.html                                                │
│  │   ├── assets/                                                   │
│  │   └── ...                                                       │
│  ├── /testsite/                                                    │
│  ├── /anotherapp/                                                  │
│  └── /_errors/                                                     │
│       └── 404.html                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Details

### 3.1 S3 Bucket Configuration

**Bucket Structure:**
```
hosting-nipalm-sites/
├── myapp/
│   ├── index.html
│   ├── main.js
│   ├── styles.css
│   └── assets/
├── testsite/
│   ├── index.html
│   └── ...
├── anotherapp/
│   └── ...
└── _errors/
    └── 404.html          # Funny custom 404 page
```

**Key Settings:**
- **Block all public access:** Enabled
- **Static website hosting:** Disabled (use REST API endpoint)
- **Object Ownership:** Bucket owner enforced
- **Versioning:** Optional (recommended for rollback)

**Bucket Policy (OAC):**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::hosting-nipalm-sites/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
        }
      }
    },
    {
      "Sid": "AllowListForExistenceCheck",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::hosting-nipalm-sites",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

### 3.2 ACM Certificate

**Requirements:**
- **Region:** us-east-1 (mandatory for CloudFront)
- **Domain Names:** 
  - `*.hosting.nipalm.com` (wildcard)
  - `hosting.nipalm.com` (apex, optional)
- **Validation:** DNS validation (auto-renewal)

**Important Notes:**
- Wildcard `*.hosting.nipalm.com` covers ONE level of subdomains only
- `myapp.hosting.nipalm.com` ✓ covered
- `sub.myapp.hosting.nipalm.com` ✗ NOT covered
- Certificate must be in us-east-1 regardless of bucket region

### 3.3 CloudFront Distribution

**Origin Configuration:**
| Setting | Value |
|---------|-------|
| Origin Domain | `hosting-nipalm-sites.s3.REGION.amazonaws.com` |
| Origin Path | (empty) |
| Origin Access | Origin Access Control (OAC) |
| Protocol | HTTPS only |

**Distribution Settings:**
| Setting | Value |
|---------|-------|
| Alternate Domain Names | `*.hosting.nipalm.com` |
| SSL Certificate | ACM certificate from us-east-1 |
| Viewer Protocol Policy | Redirect HTTP to HTTPS |
| Default Root Object | (leave empty - handled by function) |
| Price Class | As needed |
| IPv6 | Enabled |

**Cache Behavior (Default):**
| Setting | Value |
|---------|-------|
| Viewer Request Function | `subdomain-router` (see §3.4) |
| Cache Policy | CachingOptimized or custom |
| Origin Request Policy | CORS-S3Origin (if needed) |

**⚠️ Critical:** Do NOT include `Host` header in cache policy. This breaks OAC signing.

**Custom Error Responses:**
| HTTP Code | Response Page Path | Response Code | TTL |
|-----------|-------------------|---------------|-----|
| 403 | `/_errors/404.html` | 404 | 60s |
| 404 | `/_errors/404.html` | 404 | 60s |

### 3.4 CloudFront Function

**Function Name:** `subdomain-router`  
**Event Type:** Viewer Request  
**Runtime:** cloudfront-js-2.0

```javascript
function handler(event) {
    var request = event.request;
    var host = request.headers.host.value;
    var uri = request.uri;
    
    // Configuration
    var baseDomain = '.hosting.nipalm.com';
    var errorFolder = '_errors';
    
    // Extract subdomain from host header
    var subdomain = '';
    if (host.endsWith(baseDomain)) {
        subdomain = host.replace(baseDomain, '');
    } else if (host === 'hosting.nipalm.com') {
        // Root domain - could redirect to docs or landing page
        return {
            statusCode: 302,
            statusDescription: 'Found',
            headers: {
                'location': { value: 'https://docs.hosting.nipalm.com' }
            }
        };
    }
    
    // Validate subdomain (basic sanitization)
    if (!subdomain || subdomain.includes('/') || subdomain.includes('..')) {
        // Invalid subdomain - serve 404
        request.uri = '/' + errorFolder + '/404.html';
        return request;
    }
    
    // Handle SPA routing: if URI has no file extension, serve index.html
    // This allows client-side routing to work
    var hasExtension = /\.\w+$/.test(uri);
    var endsWithSlash = uri.endsWith('/');
    
    if (endsWithSlash) {
        // /path/ → /subdomain/path/index.html
        request.uri = '/' + subdomain + uri + 'index.html';
    } else if (!hasExtension) {
        // /path → /subdomain/path/index.html (SPA route)
        request.uri = '/' + subdomain + uri + '/index.html';
    } else {
        // /path/file.js → /subdomain/path/file.js
        request.uri = '/' + subdomain + uri;
    }
    
    return request;
}
```

**Alternative: Keep SPA routes as-is (let app handle 404)**
```javascript
function handler(event) {
    var request = event.request;
    var host = request.headers.host.value;
    var uri = request.uri;
    
    var baseDomain = '.hosting.nipalm.com';
    var subdomain = host.replace(baseDomain, '');
    
    if (!subdomain || subdomain === host) {
        request.uri = '/_errors/404.html';
        return request;
    }
    
    // Prepend subdomain as folder
    request.uri = '/' + subdomain + uri;
    
    // Only append index.html for paths ending in /
    if (uri.endsWith('/')) {
        request.uri += 'index.html';
    } else if (uri === '' || uri === '/') {
        request.uri = '/' + subdomain + '/index.html';
    }
    
    return request;
}
```

### 3.5 Route53 Configuration

**Hosted Zone:** `nipalm.com` (or `hosting.nipalm.com` as subdomain zone)

**Records Required:**

| Record Name | Type | Alias | Target |
|-------------|------|-------|--------|
| `*.hosting.nipalm.com` | A | Yes | CloudFront distribution |
| `*.hosting.nipalm.com` | AAAA | Yes | CloudFront distribution (if IPv6) |

**Key Points:**
- Use Alias records (not CNAME) - free queries + better performance
- Single wildcard record routes ALL subdomains to CloudFront
- No per-tenant DNS configuration needed

---

## 4. Deployment Workflow

### 4.1 Initial Infrastructure Setup (One-time)

1. **Create S3 bucket** with settings from §3.1
2. **Request ACM certificate** in us-east-1
3. **Create CloudFront Function** with code from §3.4
4. **Create CloudFront Distribution** with settings from §3.3
5. **Update S3 bucket policy** with OAC ARN
6. **Create Route53 records** as per §3.5
7. **Upload error pages** to `/_errors/`

### 4.2 Deploying a New Site (Zero-config!)

```bash
# Build your SPA
npm run build

# Upload to S3 (creates the folder automatically)
aws s3 sync ./dist s3://hosting-nipalm-sites/mynewapp/ \
    --delete \
    --cache-control "max-age=31536000" \
    --exclude "index.html" 

# Upload index.html with no-cache
aws s3 cp ./dist/index.html s3://hosting-nipalm-sites/mynewapp/index.html \
    --cache-control "no-cache, no-store, must-revalidate"

# Optional: Invalidate CloudFront cache
aws cloudfront create-invalidation \
    --distribution-id DISTRIBUTION_ID \
    --paths "/mynewapp/*"
```

**That's it!** `https://mynewapp.hosting.nipalm.com` now works.

### 4.3 Removing a Site

```bash
# Delete all objects in the folder
aws s3 rm s3://hosting-nipalm-sites/mynewapp/ --recursive

# Invalidate cache
aws cloudfront create-invalidation \
    --distribution-id DISTRIBUTION_ID \
    --paths "/mynewapp/*"
```

---

## 5. SPA Routing Considerations

### 5.1 The Problem

SPAs use client-side routing (React Router, Vue Router, Angular Router). When a user:
1. Visits `https://myapp.hosting.nipalm.com/dashboard`
2. S3 looks for `/myapp/dashboard` (doesn't exist)
3. Returns 403/404 error

### 5.2 Solutions

**Option A: CloudFront Function (Recommended)**
- Rewrite non-file URIs to index.html in the function
- Pros: Per-behavior control, no SEO issues
- Cons: Slightly more complex function

**Option B: Custom Error Response**
- Configure 403/404 → Return `/myapp/index.html` with 200
- Pros: Simple setup
- Cons: Returns 200 for actual missing files (bad for SEO), affects all behaviors

**Option C: Hybrid**
- Use CloudFront Function for URI rewriting
- Use Custom Error Response as fallback for truly missing subdomains

### 5.3 Recommended Function Logic

```javascript
// Determine if this is likely an SPA route or a real file
function isAssetRequest(uri) {
    // Common asset extensions
    var assetExtensions = [
        '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg',
        '.woff', '.woff2', '.ttf', '.eot', '.ico', '.json', 
        '.map', '.webp', '.mp4', '.webm', '.pdf'
    ];
    return assetExtensions.some(function(ext) {
        return uri.endsWith(ext);
    });
}
```

---

## 6. Custom 404 Page for Non-Existent Subdomains

### 6.1 Create the Error Page

**File:** `/_errors/404.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>404 - Site Not Found</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container { text-align: center; padding: 2rem; }
        h1 { font-size: 8rem; margin: 0; }
        .message { font-size: 1.5rem; margin: 1rem 0; }
        .joke { font-size: 1.2rem; opacity: 0.9; margin-top: 2rem; }
    </style>
</head>
<body>
    <div class="container">
        <h1>404</h1>
        <p class="message">This site doesn't exist... yet!</p>
        <p class="joke">🚀 Maybe it's still being deployed?<br>
        Or perhaps you invented a new subdomain. Impressive!</p>
    </div>
</body>
</html>
```

### 6.2 How It Works

When S3 returns 403 (access denied = file not found with OAC):
1. CloudFront catches the error
2. Custom Error Response returns `/_errors/404.html`
3. Status code changed to 404

---

## 7. Security Considerations

### 7.1 Access Control
- S3 bucket is **completely private**
- Only CloudFront (via OAC) can access objects
- No direct S3 URL access possible

### 7.2 Input Validation
- CloudFront Function validates subdomain format
- Prevents path traversal attacks (`../`)
- Sanitize subdomain input

### 7.3 HTTPS
- All traffic uses HTTPS (HTTP redirected)
- TLS 1.2+ enforced by CloudFront

### 7.4 Headers
Consider adding security headers via CloudFront Response Headers Policy:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000`

---

## 8. Cost Estimation

| Component | Pricing Model | Estimate (10 sites, 100GB/mo) |
|-----------|---------------|------------------------------|
| S3 Storage | $0.023/GB | ~$2.30/mo |
| S3 Requests | $0.0004/1000 GET | ~$0.40/mo |
| CloudFront Data Transfer | $0.085/GB (first 10TB) | ~$8.50/mo |
| CloudFront Requests | $0.0075/10000 HTTPS | ~$0.75/mo |
| CloudFront Functions | $0.10/million invocations | ~$0.10/mo |
| Route53 Hosted Zone | $0.50/zone | $0.50/mo |
| Route53 Queries | $0.40/million (Alias=free) | $0.00 |
| ACM Certificate | Free | $0.00 |

**Estimated Total: ~$12-15/month** for moderate usage

---

## 9. Limitations & Considerations

### 9.1 Known Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| Single subdomain level only | `sub.myapp.hosting...` won't work | Request multi-level cert |
| 25 alternate domains per distribution | N/A for wildcards | Wildcards count as 1 |
| CloudFront Function 10KB code limit | Limited logic | Use Lambda@Edge for complex cases |
| No server-side rendering | Static files only | Use separate compute for SSR |
| Cache invalidation takes time | Updates not instant | Use versioned filenames |

### 9.2 What This Design Supports

✅ Unlimited subdomains (tenant sites)  
✅ SPA frameworks (React, Vue, Angular, etc.)  
✅ Static site generators (Hugo, Gatsby, Next.js export)  
✅ Automatic HTTPS for all subdomains  
✅ Zero DNS configuration per tenant  
✅ Global CDN distribution  
✅ Private S3 bucket (secure)

### 9.3 What This Design Does NOT Support

❌ Server-side rendering (SSR)  
❌ API endpoints (use API Gateway separately)  
❌ File uploads (need separate mechanism)  
❌ Per-tenant custom domains (would need separate distributions)  
❌ Authentication/authorization (add Cognito or Lambda@Edge)

---

## 10. Terraform/CloudFormation Reference

See companion infrastructure-as-code templates for automated deployment.

---

## 11. Verification Checklist

After deployment, verify:

- [ ] `https://test.hosting.nipalm.com` serves `/test/index.html`
- [ ] `https://test.hosting.nipalm.com/someroute` serves `/test/index.html` (SPA)
- [ ] `https://test.hosting.nipalm.com/assets/app.js` serves `/test/assets/app.js`
- [ ] `https://nonexistent.hosting.nipalm.com` shows custom 404 page
- [ ] HTTP redirects to HTTPS
- [ ] Direct S3 URL access is denied
- [ ] New folder upload immediately creates working subdomain

---

## Appendix A: Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| SignatureDoesNotMatch | Host header in cache policy | Remove Host from cache policy |
| AccessDenied on all requests | Bucket policy incorrect | Verify OAC ARN in policy |
| 502 Bad Gateway | Origin misconfigured | Check origin domain name |
| Certificate error | Cert not in us-east-1 | Re-request in us-east-1 |
| Subdomain not working | DNS propagation | Wait 60s, check Route53 |
| Old content showing | Caching | Create invalidation |
