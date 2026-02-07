import { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';
import * as jose from 'jose';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Config cached from SSM
let config: {
  cognitoDomain: string;
  clientId: string;
  clientSecret: string;
  cognitoRegion: string;
  userPoolId: string;
  callbackUrl: string;
} | null = null;

const COOKIE_NAME = 'hosting_auth';
const COOKIE_DOMAIN = '.hosting.nipalm.com';
const BASE_DOMAIN = '.hosting.nipalm.com';
const APEX_DOMAIN = 'hosting.nipalm.com';
const SSM_PARAM_NAME = '/hosting-nipalm/auth-config';

let jwks: jose.JWTVerifyGetKey | null = null;

async function loadConfig(): Promise<typeof config> {
  if (config) return config;

  const ssm = new SSMClient({ region: 'us-east-1' });
  const result = await ssm.send(new GetParameterCommand({
    Name: SSM_PARAM_NAME,
    WithDecryption: true,
  }));

  if (!result.Parameter?.Value) {
    throw new Error('Auth config not found in SSM');
  }

  config = JSON.parse(result.Parameter.Value);
  return config;
}

async function getJWKS(userPoolId: string, region: string): Promise<jose.JWTVerifyGetKey> {
  if (!jwks) {
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    jwks = jose.createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  return jwks;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length > 0) {
      cookies[name] = rest.join('=');
    }
  });
  return cookies;
}

// State contains: originalHost|originalPath
function encodeState(host: string, path: string): string {
  return Buffer.from(`${host}|${path}`).toString('base64');
}

function decodeState(state: string): { host: string; path: string } {
  try {
    const decoded = Buffer.from(state, 'base64').toString('utf-8');
    const [host, ...pathParts] = decoded.split('|');
    return { host, path: pathParts.join('|') || '/' };
  } catch {
    return { host: APEX_DOMAIN, path: '/' };
  }
}

function buildLoginUrl(cognitoDomain: string, clientId: string, callbackUrl: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid email',
    redirect_uri: callbackUrl,
    state: state,
  });
  return `https://${cognitoDomain}/login?${params.toString()}`;
}

async function exchangeCodeForTokens(
  code: string,
  callbackUrl: string,
  cognitoDomain: string,
  clientId: string,
  clientSecret: string
): Promise<{ idToken: string; accessToken: string; refreshToken?: string } | null> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`https://${cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: callbackUrl,
    }).toString(),
  });

  if (!response.ok) {
    console.error('Token exchange failed:', await response.text());
    return null;
  }

  const data = await response.json() as { id_token: string; access_token: string; refresh_token?: string };
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

async function verifyToken(token: string, userPoolId: string, region: string, clientId: string): Promise<boolean> {
  try {
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    const jwksClient = await getJWKS(userPoolId, region);

    await jose.jwtVerify(token, jwksClient, {
      issuer,
      audience: clientId,
    });
    return true;
  } catch (err) {
    console.error('Token verification failed:', err);
    return false;
  }
}

function createAuthCookie(idToken: string, maxAge: number = 3600): string {
  return `${COOKIE_NAME}=${idToken}; Domain=${COOKIE_DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location: string, cookies?: string[]): CloudFrontRequestResult {
  const headers: Record<string, Array<{ key: string; value: string }>> = {
    location: [{ key: 'Location', value: location }],
  };

  if (cookies && cookies.length > 0) {
    headers['set-cookie'] = cookies.map(cookie => ({ key: 'Set-Cookie', value: cookie }));
  }

  return {
    status: '302',
    statusDescription: 'Found',
    headers,
  };
}

// Subdomain routing logic
function applySubdomainRouting(request: CloudFrontRequestEvent['Records'][0]['cf']['request'], host: string): void {
  const uri = request.uri;
  const errorFolder = '_errors';

  // Extract subdomain from host header
  let subdomain = '';
  if (host.endsWith(BASE_DOMAIN)) {
    subdomain = host.replace(BASE_DOMAIN, '');
  } else if (host === APEX_DOMAIN) {
    // Apex domain - serve 404
    request.uri = '/' + errorFolder + '/404.html';
    return;
  }

  // Validate subdomain
  if (!subdomain || subdomain.includes('/') || subdomain.includes('..')) {
    request.uri = '/' + errorFolder + '/404.html';
    return;
  }

  // Handle SPA routing: if URI has no file extension, serve index.html
  const hasExtension = /\.\w+$/.test(uri);
  const endsWithSlash = uri.endsWith('/');

  if (endsWithSlash) {
    request.uri = '/' + subdomain + uri + 'index.html';
  } else if (!hasExtension) {
    request.uri = '/' + subdomain + uri + '/index.html';
  } else {
    request.uri = '/' + subdomain + uri;
  }
}

export async function handler(event: CloudFrontRequestEvent): Promise<CloudFrontRequestResult> {
  const request = event.Records[0].cf.request;
  const host = request.headers.host?.[0]?.value || '';
  const uri = request.uri;
  const querystring = request.querystring || '';

  // Load config from SSM (cached after first call)
  let cfg: typeof config;
  try {
    cfg = await loadConfig();
    if (!cfg) {
      throw new Error('Config is null');
    }
  } catch (err) {
    console.error('Failed to load config:', err);
    return {
      status: '500',
      statusDescription: 'Internal Server Error',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'text/html' }],
      },
      body: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>500 - Service Error</title>
    <style>
        body {
            font-family: Baskerville, 'Palatino Linotype', Georgia, serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(145deg, #0d1f0d 0%, #1a3a1a 50%, #0f2810 100%);
            color: #c9b896;
        }
        .container { text-align: center; padding: 3rem; max-width: 480px; }
        .ornament { color: #d4af37; font-size: 1.5rem; letter-spacing: 0.5em; margin-bottom: 1rem; }
        h1 { font-size: 7rem; margin: 0; color: #d4af37; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); font-weight: normal; letter-spacing: 0.15em; }
        .message { font-size: 1.4rem; margin: 1.5rem 0 0.5rem; font-style: italic; letter-spacing: 0.05em; }
        .divider { width: 60px; height: 1px; background: #d4af37; margin: 2rem auto; opacity: 0.5; }
        .subtext { font-size: 1rem; opacity: 0.7; margin-top: 2rem; line-height: 1.9; letter-spacing: 0.03em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="ornament">&#8226; &#8226; &#8226;</div>
        <h1>500</h1>
        <p class="message">Most unfortunate, indeed.</p>
        <div class="divider"></div>
        <p class="subtext">The service has encountered a spot of bother.<br>Do try again in a moment.</p>
    </div>
</body>
</html>`,
    };
  }

  // Handle OAuth callback (only on apex domain)
  if (uri === '/_auth/callback') {
    const params = new URLSearchParams(querystring);
    const code = params.get('code');
    const state = params.get('state');

    if (!code) {
      return redirect('/');
    }

    const tokens = await exchangeCodeForTokens(
      code,
      cfg.callbackUrl,
      cfg.cognitoDomain,
      cfg.clientId,
      cfg.clientSecret
    );
    if (!tokens) {
      return redirect('/');
    }

    // Decode state to get original host and path
    const { host: originalHost, path: originalPath } = decodeState(state || '');
    const redirectUrl = `https://${originalHost}${originalPath}`;

    // Set cookie and redirect to original URL
    return redirect(redirectUrl, [createAuthCookie(tokens.idToken)]);
  }

  // Handle root domain - serve 404 page
  if (host === APEX_DOMAIN && uri !== '/_auth/callback') {
    request.uri = '/_errors/404.html';
    return request;
  }

  // Check for valid auth cookie
  const cookieHeader = request.headers.cookie?.[0]?.value;
  const cookies = parseCookies(cookieHeader);
  const authToken = cookies[COOKIE_NAME];

  if (authToken) {
    const isValid = await verifyToken(authToken, cfg.userPoolId, cfg.cognitoRegion, cfg.clientId);
    if (isValid) {
      // Token valid, apply routing and continue to origin
      applySubdomainRouting(request, host);
      return request;
    }
  }

  // No valid token, redirect to login
  // Store original host and path in state
  const originalPath = uri + (querystring ? `?${querystring}` : '');
  const state = encodeState(host, originalPath);
  const loginUrl = buildLoginUrl(cfg.cognitoDomain, cfg.clientId, cfg.callbackUrl, state);

  return redirect(loginUrl);
}
