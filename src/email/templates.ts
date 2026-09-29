/**
 * xorgate's transactional email templates — the ONE place the platform's
 * outbound mail is styled. Every message xorgate sends (Cognito's
 * verification / invitation / password-reset mails, rendered through the
 * CustomMessage trigger, and the API's own SES sends) is built here, so the
 * brand cannot drift between the two senders.
 *
 * The visual language mirrors xorgate-web's theme (src/index.css): brand
 * `#ff3a00` (the `--brand` token, NOT `--primary`, which is neutral), a 10px
 * corner radius (`--radius: 0.625rem`), near-black text on a light shell, and
 * Figtree with a system fallback. Everything is table-based with inline
 * styles because that is still the only layout email clients agree on. The
 * header mark is a HOSTED PNG (Gmail strips inline SVG and blocks data-URI
 * images, so the console's SVG cannot be used directly), rendered from
 * xorgate-web/public/xorgate-logo.svg; the wordmark beside it stays as text,
 * so the brand still reads when a client blocks images.
 *
 * Cognito caps a custom email at 20,000 characters; the rendered layout is
 * comfortably under 6 KB, which leaves room for any body below.
 */

const BRAND = {
  /** --brand: oklch(0.6641 0.2454 34.85) */
  accent: '#ff3a00',
  /** --brand-strong: oklch(0.55 0.21 35) — link text, which needs contrast */
  accentStrong: '#cf2500',
  /** --brand-wash: oklch(0.955 0.025 45) */
  wash: '#ffebe3',
  ink: '#1c1917',
  muted: '#78716c',
  border: '#e7e5e4',
  canvas: '#f5f5f4',
  card: '#ffffff',
} as const;

/** --radius: 0.625rem, in the px an email client will actually honour. */
const RADIUS = '10px';

/**
 * The xorgate mark, a 264x96 transparent PNG rendered from
 * xorgate-web/public/xorgate-logo.svg and served by the landing site
 * (xorgate-landing/public/xorgate-mark.png, also uploaded straight to the
 * www.xorgate.io bucket so it does not wait on a landing deploy). Displayed at
 * a third of its pixel size so it stays sharp on retina.
 *
 * One absolute URL for every stage: a dev email may as well load the
 * prod-hosted image, and a second copy would only be one more thing to keep in
 * sync. If it ever 404s the header degrades to the "Xorgate" text beside it,
 * which is why the wordmark is not baked into the image.
 */
const LOGO_URL = 'https://www.xorgate.io/xorgate-mark.png';
const LOGO_WIDTH = 66;
const LOGO_HEIGHT = 24;

const FONT =
  "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

export interface RenderedEmail {
  subject: string;
  html: string;
  /** Plain-text alternative; SES sends it as the multipart/alternative sibling. */
  text: string;
}

/** Escape anything user-controlled before it lands in HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface LayoutOptions {
  /** Inbox preview line; hidden in the body itself. */
  preheader: string;
  title: string;
  /** Paragraphs, already HTML-escaped where they carry user input. */
  paragraphs: string[];
  /**
   * A one-time code (or a Cognito placeholder) rendered large and monospaced.
   * `tight` is for values that are read as words rather than digits (a mixed-case
   * temporary password), which wide tracking makes harder, not easier, to read.
   */
  code?: { label: string; value: string; tight?: boolean };
  button?: { label: string; href: string };
  /** Small print under the button, e.g. expiry or "ignore if this wasn't you". */
  footnote?: string;
  /** Who this went to, for the footer's "sent to" line. */
  recipient?: string;
  appUrl: string;
  /** Renders a "DEVELOPMENT" ribbon so dev mail can never pass as production. */
  stage?: 'dev' | 'prod';
}

function layout(o: LayoutOptions): string {
  const paragraphs = o.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:${BRAND.ink};">${p}</p>`,
    )
    .join('');

  const code = o.code
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:8px 0 24px;">
        <tr>
          <td style="padding:20px 24px;background:${BRAND.wash};border-radius:${RADIUS};">
            <div style="font-family:${FONT};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.muted};margin-bottom:8px;">${o.code.label}</div>
            <div style="font-family:${MONO};font-size:${o.code.tight ? 22 : 28}px;letter-spacing:${o.code.tight ? '0.04em' : '0.18em'};font-weight:600;color:${BRAND.ink};">${o.code.value}</div>
          </td>
        </tr>
      </table>`
    : '';

  const button = o.button
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 24px;">
        <tr>
          <td style="background:${BRAND.accent};border-radius:${RADIUS};">
            <a href="${o.button.href}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${o.button.label}</a>
          </td>
        </tr>
      </table>`
    : '';

  const footnote = o.footnote
    ? `<p style="margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.muted};">${o.footnote}</p>`
    : '';

  const devRibbon =
    o.stage === 'dev'
      ? `<tr><td style="padding:8px 32px;background:${BRAND.wash};border-radius:9px 9px 0 0;font-family:${FONT};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.accentStrong};">Development environment</td></tr>`
      : '';

  const sentTo = o.recipient ? `This email was sent to ${escapeHtml(o.recipient)}. ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(o.title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.canvas};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(o.preheader)}</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${BRAND.canvas};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:520px;">
        <tr>
          <td style="padding:0 0 20px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="width:${LOGO_WIDTH}px;"><img src="${LOGO_URL}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="" style="display:block;border:0;" /></td>
                <td style="padding-left:12px;font-family:${FONT};font-size:19px;font-weight:600;letter-spacing:-0.02em;color:${BRAND.ink};">Xorgate</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:${RADIUS};">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              ${devRibbon}
              <tr>
                <td style="padding:32px 32px 24px;">
                  <h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.02em;color:${BRAND.ink};">${escapeHtml(o.title)}</h1>
                  ${paragraphs}
                  ${code}
                  ${button}
                  ${footnote}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">
            ${sentTo}xorgate is the platform for building, deploying, and operating physical AI on edge devices.
            <a href="${o.appUrl}" style="color:${BRAND.accentStrong};text-decoration:none;">${o.appUrl.replace(/^https?:\/\//, '')}</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function textVersion(lines: Array<string | undefined>): string {
  return lines.filter((l): l is string => Boolean(l)).join('\n\n');
}

export interface BrandContext {
  appUrl: string;
  stage: 'dev' | 'prod';
}

function greeting(name?: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Hi ${escapeHtml(first)},` : 'Hi,';
}

/** Self-signup: the code Cognito emails to confirm the address. */
export function verificationEmail(
  ctx: BrandContext,
  p: { code: string; email: string; name?: string | null },
): RenderedEmail {
  const subject = 'Verify your email for xorgate';
  return {
    subject,
    html: layout({
      ...ctx,
      preheader: 'Enter this code to finish creating your xorgate account.',
      title: 'Verify your email',
      paragraphs: [
        greeting(p.name),
        'Thanks for signing up. Enter the code below on the verification screen to activate your account.',
      ],
      code: { label: 'Verification code', value: p.code },
      footnote:
        'The code expires in 24 hours. If you did not create a xorgate account, you can safely ignore this email.',
      recipient: p.email,
    }),
    text: textVersion([
      subject,
      `Your verification code is: ${p.code}`,
      'The code expires in 24 hours. If you did not create a xorgate account, ignore this email.',
    ]),
  };
}

/** Forgot password: the code that authorizes choosing a new one. */
export function passwordResetEmail(
  ctx: BrandContext,
  p: { code: string; email: string; name?: string | null },
): RenderedEmail {
  const subject = 'Reset your xorgate password';
  return {
    subject,
    html: layout({
      ...ctx,
      preheader: 'Use this code to choose a new password.',
      title: 'Reset your password',
      paragraphs: [
        greeting(p.name),
        'We received a request to reset the password for your xorgate account. Enter the code below to choose a new one.',
      ],
      code: { label: 'Reset code', value: p.code },
      button: {
        label: 'Reset password',
        href: `${ctx.appUrl}/forgot-password?email=${encodeURIComponent(p.email)}`,
      },
      footnote:
        'The code expires in one hour. If you did not request a reset, no action is needed: your password stays as it is.',
      recipient: p.email,
    }),
    text: textVersion([
      subject,
      `Your reset code is: ${p.code}`,
      `Enter it at ${ctx.appUrl}/forgot-password`,
      'The code expires in one hour. If you did not request a reset, no action is needed.',
    ]),
  };
}

/**
 * Organization invite for someone with no xorgate account yet: Cognito's
 * AdminCreateUser mail, carrying the temporary password. `username` is
 * Cognito's `{username}` placeholder, which the pool REQUIRES somewhere in the
 * body; with email-as-username it renders the internal UUID, so it is carried
 * in an HTML comment and the address the member actually signs in with is
 * shown instead.
 */
export function invitationEmail(
  ctx: BrandContext,
  p: {
    email: string;
    temporaryPassword: string;
    username: string;
    organizationName?: string | null;
    inviterName?: string | null;
  },
): RenderedEmail {
  const org = p.organizationName?.trim();
  const inviter = p.inviterName?.trim();
  const subject = org ? `You've been invited to ${org} on xorgate` : "You've been invited to xorgate";
  const invitedBy = inviter ? `${escapeHtml(inviter)} has invited you` : 'You have been invited';
  const toWhat = org ? ` to join <strong>${escapeHtml(org)}</strong> on xorgate` : ' to xorgate';
  return {
    subject,
    html: layout({
      ...ctx,
      preheader: `${inviter ?? 'Someone'} invited you${org ? ` to ${org}` : ''} on xorgate.`,
      title: org ? `Join ${org} on xorgate` : 'Welcome to xorgate',
      paragraphs: [
        `${invitedBy}${toWhat}.`,
        `Sign in to the console with <strong>${escapeHtml(p.email)}</strong> and the temporary password below. You will be asked to choose your own password right away.`,
      ],
      code: {
        label: 'Temporary password',
        value: `${p.temporaryPassword}<!-- ${p.username} -->`,
        tight: true,
      },
      button: { label: 'Sign in to xorgate', href: `${ctx.appUrl}/login` },
      footnote: 'The temporary password expires in 7 days.',
      recipient: p.email,
    }),
    text: textVersion([
      subject,
      `Sign in at ${ctx.appUrl}/login with ${p.email} and this temporary password: ${p.temporaryPassword}`,
      'You will be asked to choose your own password right away. The temporary password expires in 7 days.',
    ]),
  };
}

/**
 * Organization invite for someone who ALREADY has an account (a member of
 * another organization, or someone who self-signed up): there is no credential
 * to deliver, just the news, so the API sends this one itself through SES.
 */
export function addedToOrganizationEmail(
  ctx: BrandContext,
  p: { email: string; name?: string | null; organizationName: string; inviterName?: string | null },
): RenderedEmail {
  const inviter = p.inviterName?.trim();
  const subject = `You've been added to ${p.organizationName} on xorgate`;
  return {
    subject,
    html: layout({
      ...ctx,
      preheader: `${inviter ?? 'An administrator'} added you to ${p.organizationName}.`,
      title: `You're now a member of ${p.organizationName}`,
      paragraphs: [
        greeting(p.name),
        `${inviter ? escapeHtml(inviter) : 'An administrator'} added you to <strong>${escapeHtml(p.organizationName)}</strong>. Sign in with your existing xorgate account and switch to it from the organization menu.`,
      ],
      button: { label: 'Open the console', href: `${ctx.appUrl}/login` },
      recipient: p.email,
    }),
    text: textVersion([
      subject,
      `${inviter ?? 'An administrator'} added you to ${p.organizationName}. Sign in at ${ctx.appUrl}/login with your existing account and switch to it from the organization menu.`,
    ]),
  };
}

/** Verifying a changed email address (Cognito attribute verification). */
export function attributeVerificationEmail(
  ctx: BrandContext,
  p: { code: string; email: string; name?: string | null },
): RenderedEmail {
  const subject = 'Confirm your new email address for xorgate';
  return {
    subject,
    html: layout({
      ...ctx,
      preheader: 'Enter this code to confirm your new email address.',
      title: 'Confirm your new email address',
      paragraphs: [
        greeting(p.name),
        'Enter the code below to confirm this address for your xorgate account.',
      ],
      code: { label: 'Confirmation code', value: p.code },
      footnote:
        'If you did not change your email address, contact your organization administrator.',
      recipient: p.email,
    }),
    text: textVersion([
      subject,
      `Your confirmation code is: ${p.code}`,
      'If you did not change your email address, contact your organization administrator.',
    ]),
  };
}

/**
 * A webhook endpoint was switched off by the delivery subsystem because it
 * kept failing (services/webhooks/deliver.ts autoDisableIfFailing). Sent to
 * the org's owners; the endpoint page has the delivery log and the enable
 * switch, and enabling it clears the failure count.
 */
export function webhookEndpointDisabledEmail(
  ctx: BrandContext,
  p: {
    email: string;
    name?: string | null;
    organizationName: string;
    endpointName: string;
    endpointUrl: string;
    endpointPath: string;
    consecutiveFailures: number;
  },
): RenderedEmail {
  const subject = `Webhook endpoint ${p.endpointName} disabled`;
  const href = `${ctx.appUrl}${p.endpointPath}`;
  const why =
    `${p.consecutiveFailures} deliveries in a row used up every retry (8 attempts over about two days each), ` +
    'so xorgate stopped sending to it. Events that happen while it is disabled are not queued for it.';
  return {
    subject,
    html: layout({
      ...ctx,
      preheader: `${p.endpointName} in ${p.organizationName} kept failing and was disabled.`,
      title: subject,
      paragraphs: [
        greeting(p.name),
        `The webhook endpoint <strong>${escapeHtml(p.endpointName)}</strong> in <strong>${escapeHtml(p.organizationName)}</strong> (<span style="font-family:${MONO};">${escapeHtml(p.endpointUrl)}</span>) was disabled.`,
        escapeHtml(why),
        'Check the delivery log for the responses it returned, fix the receiver, then enable the endpoint again. Failed deliveries can be redelivered from the log.',
      ],
      button: { label: 'Open the endpoint', href },
      recipient: p.email,
    }),
    text: textVersion([
      subject,
      `The webhook endpoint ${p.endpointName} in ${p.organizationName} (${p.endpointUrl}) was disabled.`,
      why,
      `Check the delivery log, fix the receiver, then enable the endpoint again: ${href}`,
    ]),
  };
}
