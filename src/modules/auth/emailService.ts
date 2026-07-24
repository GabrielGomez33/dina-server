// File: src/modules/auth/emailService.ts
// ============================================================================
// DINA AUTH — EMAIL SERVICE (pluggable provider)
// ============================================================================
// Sends the three transactional auth emails (verify, reset, email-change). Two
// providers:
//   - 'resend'  : posts to the Resend HTTP API (no SDK dependency; uses fetch).
//   - 'console' : logs the link to stdout. The default, so local/dev works with
//                 zero config and no accidental real sends.
//
// Sending is BEST-EFFORT from the caller's perspective: a failed send never
// throws into the auth flow (registration still succeeds; the user can use the
// "resend" CTA). We return a boolean so callers can log delivery outcome.
// ============================================================================

import { getAuthConfig } from './config';

export type AuthEmailKind = 'verify' | 'reset' | 'change';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function link(path: string, token: string): string {
  const base = getAuthConfig().appBaseUrl;
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

async function deliver(args: SendArgs): Promise<boolean> {
  const cfg = getAuthConfig();
  if (cfg.emailProvider === 'console' || !cfg.resendApiKey) {
    // Dev/no-key path: make the actionable link obvious in logs.
    console.log(`\n[auth:email] (console provider) → ${args.to}`);
    console.log(`  subject: ${args.subject}`);
    console.log(`  ${args.text}\n`);
    return true;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: cfg.emailFrom,
        to: [args.to],
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
    if (!res.ok) {
      console.error(`[auth:email] Resend responded ${res.status}: ${await res.text().catch(() => '')}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[auth:email] send failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

function shell(title: string, body: string, cta: { label: string; url: string }): string {
  // Minimal, inline-styled, client-safe HTML (no external assets).
  return `<!doctype html><html><body style="margin:0;background:#17130f;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;color:#e8e3da;">
    <h1 style="font-size:18px;font-weight:600;letter-spacing:.02em;color:#c9a25a;margin:0 0 16px;">DINA</h1>
    <h2 style="font-size:20px;font-weight:600;margin:0 0 12px;color:#f2eee6;">${title}</h2>
    <p style="font-size:14px;line-height:1.6;color:#b7b1a6;margin:0 0 24px;">${body}</p>
    <a href="${cta.url}" style="display:inline-block;padding:12px 20px;border:1px solid #c9a25a;border-radius:10px;color:#f2eee6;text-decoration:none;font-size:14px;">${cta.label}</a>
    <p style="font-size:12px;line-height:1.6;color:#7c766b;margin:24px 0 0;">If the button doesn't work, paste this link into your browser:<br><span style="color:#9a948a;word-break:break-all;">${cta.url}</span></p>
  </div></body></html>`;
}

export async function sendVerificationEmail(to: string, username: string, token: string): Promise<boolean> {
  const url = link('/verify-email', token);
  return deliver({
    to,
    subject: 'Verify your DINA email',
    html: shell(`Welcome, ${username}`, 'Confirm this address to finish setting up your DINA account. This link expires in 24 hours.', { label: 'Verify email', url }),
    text: `Welcome, ${username}. Verify your DINA email (expires in 24h): ${url}`,
  });
}

export async function sendPasswordResetEmail(to: string, username: string, token: string): Promise<boolean> {
  const url = link('/reset-password', token);
  return deliver({
    to,
    subject: 'Reset your DINA password',
    html: shell('Password reset requested', `Hi ${username}, click below to choose a new password. This link expires in 1 hour. If you didn't request this, you can ignore this email.`, { label: 'Reset password', url }),
    text: `Reset your DINA password (expires in 1h): ${url}\nIf you didn't request this, ignore this email.`,
  });
}

export async function sendEmailChangeEmail(to: string, username: string, token: string): Promise<boolean> {
  const url = link('/confirm-email-change', token);
  return deliver({
    to,
    subject: 'Confirm your new DINA email',
    html: shell('Confirm your new email', `Hi ${username}, confirm this new address to finish the change. This link expires in 24 hours.`, { label: 'Confirm email', url }),
    text: `Confirm your new DINA email (expires in 24h): ${url}`,
  });
}
