import type { CustomMessageTriggerHandler } from 'aws-lambda';
import {
  attributeVerificationEmail,
  invitationEmail,
  passwordResetEmail,
  verificationEmail,
  type BrandContext,
} from '../email/templates';

/**
 * Cognito CustomMessage trigger: every email the user pool sends comes through
 * here to be re-rendered in xorgate's own template (src/email/templates.ts)
 * instead of Cognito's one-line default. Cognito still does the sending, and
 * still substitutes the code / temporary password into the placeholders it
 * hands us (`codeParameter` = `{####}`, `usernameParameter` = `{username}`),
 * which is why the templates are given the placeholders and never the secret
 * itself.
 *
 * `clientMetadata` is whatever the API passed to AdminCreateUser
 * (handlers/memberships.ts sends the organization and inviter names), so an
 * invitation can say who invited you and to what.
 *
 * Attached UNCONDITIONALLY, unlike the AccountLinkTrigger next to it in
 * auth-stack.ts: a Cognito-only pool sends exactly the same mails as a
 * federated one, and it works with the default sender as well as with SES, so
 * the branding lands before the SES cutover does.
 *
 * Sources this pool does not use (SMS, MFA `CustomMessage_Authentication`)
 * fall through untouched and keep Cognito's default.
 */
export const handler: CustomMessageTriggerHandler = async (event) => {
  const ctx: BrandContext = {
    appUrl: process.env.APP_URL ?? 'https://console.xorgate.io',
    stage: process.env.STAGE === 'prod' ? 'prod' : 'dev',
  };
  const { codeParameter, usernameParameter, userAttributes, clientMetadata } = event.request;
  const email = userAttributes.email ?? '';
  const name = userAttributes.name ?? null;

  let rendered;
  switch (event.triggerSource) {
    case 'CustomMessage_SignUp':
    case 'CustomMessage_ResendCode':
      rendered = verificationEmail(ctx, { code: codeParameter, email, name });
      break;
    case 'CustomMessage_ForgotPassword':
      rendered = passwordResetEmail(ctx, { code: codeParameter, email, name });
      break;
    case 'CustomMessage_AdminCreateUser':
      rendered = invitationEmail(ctx, {
        email,
        temporaryPassword: codeParameter,
        // Typed `string | null` in @types/aws-lambda; the pool rejects a body
        // with no {username} at all, so fall back to the raw placeholder.
        username: usernameParameter ?? '{username}',
        organizationName: clientMetadata?.organizationName ?? null,
        inviterName: clientMetadata?.inviterName ?? null,
      });
      break;
    case 'CustomMessage_UpdateUserAttribute':
    case 'CustomMessage_VerifyUserAttribute':
      rendered = attributeVerificationEmail(ctx, { code: codeParameter, email, name });
      break;
    default:
      return event;
  }

  event.response.emailSubject = rendered.subject;
  event.response.emailMessage = rendered.html;
  return event;
};
