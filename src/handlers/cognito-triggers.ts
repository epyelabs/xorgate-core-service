import type { PostConfirmationTriggerEvent, PreSignUpTriggerEvent } from 'aws-lambda';
import {
  AdminDeleteUserCommand,
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Cognito user-pool triggers that keep one identity per email across login
 * methods, so a person who signs up with a password and later clicks "Continue
 * with Google" (or the reverse) keeps one `sub`, and therefore one `users` row,
 * one set of memberships, and one API-key history.
 *
 * - PreSignUp_ExternalProvider: a federated (Google) first sign-in for an email
 *   that already has a native user gets linked onto that native user instead of
 *   creating a separate `google_...` user. Cognito still aborts this first
 *   sign-in with "Already found an entry for username" AFTER linking succeeds;
 *   the SPA's /auth/callback detects that error and retries once, and the retry
 *   resolves to the native user. All later Google logins mint tokens with the
 *   native sub.
 *
 * - PostConfirmation_ConfirmSignUp: a native signup for an email that already
 *   has a standalone federated user absorbs it (delete the `google_...` user,
 *   then link its Google identity onto the new native user). The federated
 *   user's old sub disappears, so any `users` row it provisioned is orphaned;
 *   acceptable while linking exists from early in the pool's life.
 *
 * Only providers that verify email ownership may auto-link; an IdP that lets
 * users assert arbitrary emails would otherwise enable account takeover by
 * signing in with a victim's address.
 */
const LINKABLE_PROVIDERS: Record<string, string> = {
  // hosted-UI username prefix (lowercase) -> Cognito IdP name
  google: 'Google',
};

const client = new CognitoIdentityProviderClient({});

type TriggerEvent = PreSignUpTriggerEvent | PostConfirmationTriggerEvent;

export async function handler(event: TriggerEvent): Promise<TriggerEvent> {
  if (event.triggerSource === 'PreSignUp_ExternalProvider') {
    await linkFederatedToNative(event);
  } else if (
    event.triggerSource === 'PostConfirmation_ConfirmSignUp' &&
    parseFederatedUsername(event.userName) === null
  ) {
    // Native signups only. A first-time federated sign-in also confirms
    // through here (as `google_...`); absorbing then would find and delete
    // the very user being created, and the sign-in fails with
    // "User does not exist".
    await absorbFederatedUsers(event);
  }
  return event;
}

/** Federated username is `<provider>_<provider sub>`, e.g. `google_1035…`. */
function parseFederatedUsername(
  username: string,
): { providerName: string; providerSub: string } | null {
  const sep = username.indexOf('_');
  if (sep <= 0) return null;
  const providerName = LINKABLE_PROVIDERS[username.slice(0, sep).toLowerCase()];
  if (!providerName) return null;
  return { providerName, providerSub: username.slice(sep + 1) };
}

async function listUsersByEmail(userPoolId: string, email: string): Promise<UserType[]> {
  // ListUsers filter strings take a quoted literal; emails cannot legally
  // contain a double quote, but refuse to build a broken filter if one does.
  if (email.includes('"')) return [];
  const res = await client.send(
    new ListUsersCommand({
      UserPoolId: userPoolId,
      Filter: `email = "${email}"`,
    }),
  );
  return res.Users ?? [];
}

async function linkFederatedToNative(event: PreSignUpTriggerEvent): Promise<void> {
  const parsed = parseFederatedUsername(event.userName);
  const email = event.request.userAttributes.email;
  if (!parsed || !email) return;

  const users = await listUsersByEmail(event.userPoolId, email);
  const native = users.find((u) => u.UserStatus !== 'EXTERNAL_PROVIDER');
  if (!native?.Username) return;

  await client.send(
    new AdminLinkProviderForUserCommand({
      UserPoolId: event.userPoolId,
      DestinationUser: {
        ProviderName: 'Cognito',
        ProviderAttributeValue: native.Username,
      },
      SourceUser: {
        ProviderName: parsed.providerName,
        ProviderAttributeName: 'Cognito_Subject',
        ProviderAttributeValue: parsed.providerSub,
      },
    }),
  );
}

async function absorbFederatedUsers(event: PostConfirmationTriggerEvent): Promise<void> {
  const email = event.request.userAttributes.email;
  if (!email) return;

  const users = await listUsersByEmail(event.userPoolId, email);
  for (const user of users) {
    if (user.UserStatus !== 'EXTERNAL_PROVIDER' || !user.Username) continue;
    if (user.Username === event.userName) continue; // never absorb ourselves
    const parsed = parseFederatedUsername(user.Username);
    if (!parsed) continue;

    // An already-materialized federated user cannot be linked directly: delete
    // it, then link its identity onto the native user as a placeholder that
    // the next federated sign-in resolves to.
    await client.send(
      new AdminDeleteUserCommand({
        UserPoolId: event.userPoolId,
        Username: user.Username,
      }),
    );
    await client.send(
      new AdminLinkProviderForUserCommand({
        UserPoolId: event.userPoolId,
        DestinationUser: {
          ProviderName: 'Cognito',
          ProviderAttributeValue: event.userName,
        },
        SourceUser: {
          ProviderName: parsed.providerName,
          ProviderAttributeName: 'Cognito_Subject',
          ProviderAttributeValue: parsed.providerSub,
        },
      }),
    );
  }
}
