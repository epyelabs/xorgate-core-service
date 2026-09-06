import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface XorgateCoreEmailStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
  /**
   * The sending domain to verify in SES. Prod owns `xorgate.io`; dev owns the
   * `dev.xorgate.io` subdomain, so the shared Epye sandbox account can never
   * sign mail as production and either stage's DNS can be torn out without
   * touching the other.
   */
  domain: string;
}

/**
 * Amazon SES for xorgate's outbound email: one verified domain identity with
 * Easy DKIM and a custom MAIL FROM subdomain, one configuration set, and the
 * sending-authorization policy Cognito needs to send from that identity.
 *
 * DNS for xorgate.io lives in CLOUDFLARE, not Route 53 (the same constraint
 * that makes the API's ACM certificates the user's to create), so the records
 * SES needs are emitted as stack outputs to be added by hand. All of them are
 * DNS-only records, never proxied:
 *   - 3x CNAME  <token>._domainkey.<domain> -> <token>.dkim.amazonses.com
 *   - MX        mail.<domain> -> 10 feedback-smtp.<region>.amazonses.com
 *   - TXT       mail.<domain> -> "v=spf1 include:amazonses.com ~all"
 * Until all three CNAMEs resolve the identity stays unverified and nothing
 * sends from it, which is why the user pool keeps Cognito's default sender
 * until the stage's `cognitoEmailViaSes` flag is flipped (see bin/app.ts).
 */
export class XorgateCoreEmailStack extends cdk.Stack {
  public readonly identity: ses.EmailIdentity;
  public readonly configurationSet: ses.ConfigurationSet;
  public readonly domain: string;
  public readonly fromAddress: string;
  public readonly fromName: string;

  constructor(scope: Construct, id: string, props: XorgateCoreEmailStackProps) {
    super(scope, id, props);

    const isProd = props.stage === 'prod';
    this.domain = props.domain;
    this.fromAddress = `no-reply@${props.domain}`;
    // Capitalized: this is the sender name a recipient sees in their inbox
    // list, where the console's lowercase wordmark reads as a typo rather than
    // as styling. Body copy stays lowercase, matching the product's own voice.
    this.fromName = isProd ? 'Xorgate' : 'Xorgate (dev)';

    this.configurationSet = new ses.ConfigurationSet(this, 'TransactionalConfigurationSet', {
      configurationSetName: isProd ? 'xorgate-transactional' : 'xorgate-transactional-dev',
      reputationMetrics: true,
      sendingEnabled: true,
    });

    this.identity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.domain(props.domain),
      configurationSet: this.configurationSet,
      mailFromDomain: `mail.${props.domain}`,
      // Keep sending (with amazonses.com as the envelope sender) while the MX
      // record is still missing, rather than refusing every email until the
      // user has pasted it into Cloudflare.
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
    });

    // Sending authorization for Cognito. CloudFormation has no resource for an
    // SES identity policy, so it is written through the SES API. Scoped to
    // this account's user pools by SourceAccount + an ArnLike on the pool ARN
    // rather than to one concrete pool: naming the pool would make this stack
    // depend on the auth stack, which already depends on this identity.
    const identityArn = `arn:aws:ses:${this.region}:${this.account}:identity/${props.domain}`;
    const policyName = 'AllowCognitoSend';
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: policyName,
          Effect: 'Allow',
          Principal: { Service: 'cognito-idp.amazonaws.com' },
          Action: ['ses:SendEmail', 'ses:SendRawEmail'],
          Resource: identityArn,
          Condition: {
            StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike: {
              'aws:SourceArn': `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`,
            },
          },
        },
      ],
    });
    const policyParams = { EmailIdentity: props.domain, PolicyName: policyName, Policy: policy };
    const physicalResourceId = cr.PhysicalResourceId.of(`${props.domain}/${policyName}`);
    const cognitoPolicy = new cr.AwsCustomResource(this, 'CognitoSendingPolicy', {
      onCreate: {
        service: 'sesv2',
        action: 'CreateEmailIdentityPolicy',
        parameters: policyParams,
        physicalResourceId,
      },
      onUpdate: {
        service: 'sesv2',
        action: 'UpdateEmailIdentityPolicy',
        parameters: policyParams,
        physicalResourceId,
      },
      onDelete: {
        service: 'sesv2',
        action: 'DeleteEmailIdentityPolicy',
        parameters: { EmailIdentity: props.domain, PolicyName: policyName },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'ses:CreateEmailIdentityPolicy',
            'ses:UpdateEmailIdentityPolicy',
            'ses:DeleteEmailIdentityPolicy',
          ],
          resources: [identityArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    cognitoPolicy.node.addDependency(this.identity);

    new cdk.CfnOutput(this, 'SendingDomain', { value: props.domain });
    new cdk.CfnOutput(this, 'FromAddress', { value: `${this.fromName} <${this.fromAddress}>` });
    // The Cloudflare records, one output each, ready to paste.
    for (const n of [1, 2, 3] as const) {
      new cdk.CfnOutput(this, `DnsDkimCname${n}`, {
        value: `CNAME ${this.identity[`dkimDnsTokenName${n}`]} -> ${this.identity[`dkimDnsTokenValue${n}`]}`,
      });
    }
    new cdk.CfnOutput(this, 'DnsMailFromMx', {
      value: `MX mail.${props.domain} -> 10 feedback-smtp.${this.region}.amazonses.com`,
    });
    new cdk.CfnOutput(this, 'DnsMailFromSpf', {
      value: `TXT mail.${props.domain} -> "v=spf1 include:amazonses.com ~all"`,
    });
  }
}
