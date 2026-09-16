import crypto from 'crypto';

// ---------------------------------------------------------------------------
// OAuth state store (in-memory, 10-minute TTL, cleaned every 5 minutes)
// ---------------------------------------------------------------------------

interface OAuthState {
  provider: string;
  createdAt: number;
  redirectTo?: string;
}

const oauthStates = new Map<string, OAuthState>();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) {
    if (v.createdAt < cutoff) oauthStates.delete(k);
  }
}, 5 * 60 * 1000).unref();

export function generateState(provider: string, redirectTo?: string): string {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider, createdAt: Date.now(), redirectTo });
  return state;
}

/**
 * Validates and consumes a CSRF state token.
 * Returns the redirectTo URL (may be empty string) on success, or false if the
 * state is unknown, expired, or for a different provider.
 */
export function validateState(state: string, expectedProvider: string): string | false {
  const entry = oauthStates.get(state);
  if (!entry || entry.provider !== expectedProvider) return false;
  oauthStates.delete(state);
  return entry.redirectTo ?? '';
}

// ---------------------------------------------------------------------------
// Google OAuth2
// ---------------------------------------------------------------------------

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: (process.env.OAUTH_REDIRECT_BASE ?? '') + '/api/auth/oauth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(
  code: string
): Promise<{ email: string; name: string; sub: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: (process.env.OAUTH_REDIRECT_BASE ?? '') + '/api/auth/oauth/google/callback',
      grant_type: 'authorization_code',
    }),
  });

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(data.error ?? 'Google token exchange failed');

  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const user = (await userRes.json()) as { email?: string; name?: string; sub?: string };
  if (!user.email) throw new Error('No email returned from Google');

  return { email: user.email, name: user.name ?? user.email, sub: user.sub ?? '' };
}

// ---------------------------------------------------------------------------
// GitHub OAuth2
// ---------------------------------------------------------------------------

export function buildGithubAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID ?? '',
    redirect_uri: (process.env.OAUTH_REDIRECT_BASE ?? '') + '/api/auth/oauth/github/callback',
    scope: 'user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeGithubCode(
  code: string
): Promise<{ email: string; name: string; sub: string }> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID ?? '',
      client_secret: process.env.GITHUB_CLIENT_SECRET ?? '',
      code,
      redirect_uri: (process.env.OAUTH_REDIRECT_BASE ?? '') + '/api/auth/oauth/github/callback',
    }),
  });

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(data.error ?? 'GitHub token exchange failed');

  const [userRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
        'User-Agent': 'DoomsDesk',
      },
    }),
    fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
        'User-Agent': 'DoomsDesk',
      },
    }),
  ]);

  const githubUser = (await userRes.json()) as {
    login?: string;
    name?: string;
    id?: number;
  };
  const emails = (await emailsRes.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;

  const primary = emails.find((e) => e.primary && e.verified);
  if (!primary) throw new Error('No verified primary email from GitHub');

  return {
    email: primary.email,
    name: githubUser.name ?? githubUser.login ?? primary.email,
    sub: String(githubUser.id ?? ''),
  };
}
