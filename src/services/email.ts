import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { BrandContext, RenderedEmail } from '../email/templates';

/**
 * The API's own outbound email, over SES. Cognito's mails (verification,
 * invitation, password reset) do NOT pass through here — the pool sends those
 * itself, styled by the CustomMessage trigger — so this is for everything
 * xorgate says on its own account: today "you've been added to an
 * organization", later alerts and digests.
 *
 * Sending is best-effort by design. A failed email must never fail the request
 * that triggered it (the membership row is the fact; the email is a courtesy),
 * so failures are logged with enough context to chase and then swallowed.
 * While an SES account is still in the sandbox only verified recipients
 * receive anything; the same logging covers that.
 */

const client = new SESv2Client({});

export function brandContext(): BrandContext {
  return {
    appUrl: process.env.APP_URL ?? 'https://console.xorgate.io',
    stage: process.env.STAGE === 'prod' ? 'prod' : 'dev',
  };
}

export async function sendEmail(to: string, email: RenderedEmail): Promise<boolean> {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    console.warn('[email] EMAIL_FROM is not configured; not sending', {
      to,
      subject: email.subject,
    });
    return false;
  }
  try {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: process.env.EMAIL_CONFIGURATION_SET || undefined,
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: email.html, Charset: 'UTF-8' },
              Text: { Data: email.text, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error('[email] send failed', { to, subject: email.subject, err });
    return false;
  }
}
