const offerIdParams = [
  { $ref: '#/components/parameters/OrganizationIdHeader' },
];

const codeParam = {
  name: 'code',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description:
    'The offer code. Treat it as a secret: it is what authorizes the destination to read ' +
    'the offer and act on it.',
};

/**
 * The cross-organization handover surface.
 *
 * Its own tag rather than a corner of Devices: the `/transfer-offers` routes are
 * reached by an organization that has no relationship to the device yet, which
 * is a different mental model from everything under `/devices`.
 */
export const transferOffersPaths = {
  '/devices/{id}/transfer-offers': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    post: {
      operationId: 'createTransferOffer',
      summary: 'Offer a device to another organization',
      description:
        'Mints a code that another organization can redeem to take ownership of this device.\n\n' +
        'Use this when you do NOT share a membership with the destination — a genuine handover ' +
        'to a customer. If you personally hold `owner` or `admin` in both organizations, ' +
        '`POST /devices/{id}/transfer` with an `organizationId` does the same move in one call.\n\n' +
        '**The code is a bearer token.** Anyone holding it can read the offer\'s preview and ' +
        'accept or decline it. Send it over a channel you trust. It expires after 7 days.\n\n' +
        '**Idempotent.** A device has at most one open offer. Calling this again while one is ' +
        'pending returns the existing offer with **200** instead of minting a second claimable ' +
        'code; a genuinely new offer returns **201**.\n\n' +
        '`willDetachWorkflowAttachments` names the workflow templates this device is attached ' +
        'to. If the offer is accepted by a different organization they are all detached, ' +
        'because they belong to yours and the new owner cannot see them. It is returned HERE, ' +
        'at creation, because you are not present when the offer is accepted — this is the last ' +
        'point at which you can reconsider.',
      tags: ['Transfer Offers'],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      },
      responses: {
        '200': {
          description: 'An offer was already open for this device; it is returned unchanged.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TransferOfferCreated' },
            },
          },
        },
        '201': {
          description: 'A new offer.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TransferOfferCreated' },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
    get: {
      operationId: 'listDeviceTransferOffers',
      summary: 'Every transfer offer ever made for a device',
      description:
        'Open and resolved offers, newest first. A pending offer past its expiry is flipped to ' +
        '`expired` as it is read, so the status you see is always current.',
      tags: ['Transfer Offers'],
      responses: {
        '200': {
          description: 'The device\'s offers.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['offers'],
                properties: {
                  offers: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/TransferOffer' },
                  },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },

  '/transfer-offers': {
    parameters: offerIdParams,
    get: {
      operationId: 'listTransferOffers',
      summary: 'Transfer offers this organization sent or accepted',
      description:
        'Offers your organization CREATED, plus offers it has already ACCEPTED, newest first. ' +
        '`direction` tells them apart.\n\n' +
        '**There is no inbox of incoming pending offers, by design.** An offer names no ' +
        'destination — that is exactly what lets it be handed to an organization whose id the ' +
        'sender does not know — so a pending offer is discoverable only by its code. If someone ' +
        'has offered you a device, you will have been sent a code; read it with ' +
        '`GET /transfer-offers/{code}`.\n\n' +
        'Declines are visible here: an offer the destination refused reads `declined` with ' +
        '`resolvedAt` set, rather than quietly expiring.',
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: {
            type: 'string',
            enum: ['pending', 'accepted', 'declined', 'cancelled', 'expired'],
          },
          description: 'Filter by status. Anything else is a 400.',
        },
      ],
      tags: ['Transfer Offers'],
      responses: {
        '200': {
          description: 'Up to 200 offers, newest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['offers'],
                properties: {
                  offers: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/TransferOffer' },
                  },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },

  '/transfer-offers/{code}': {
    parameters: [codeParam, { $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'getTransferOffer',
      summary: 'Read an offer you were sent a code for',
      description:
        'What the code buys, and nothing else: the device\'s name and model, the offering ' +
        'organization\'s name, and the offer\'s own status and expiry.\n\n' +
        '**Deliberately absent**: the device id, its serial, its workspace, its configuration ' +
        'and its telemetry. Whoever holds the code is not yet entitled to the device, so the ' +
        'code must not double as a read primitive against someone else\'s fleet.\n\n' +
        'Any role may read this. Accepting or declining needs `owner` or `admin`.',
      tags: ['Transfer Offers'],
      responses: {
        '200': {
          description: 'The offer preview.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['offer'],
                properties: { offer: { $ref: '#/components/schemas/TransferOfferPreview' } },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
    delete: {
      operationId: 'cancelTransferOffer',
      summary: 'Withdraw an offer you created',
      description:
        'Only the organization that created the offer can cancel it, and only while it is still ' +
        'pending. An offer belonging to another organization reads as **404**, not 403.',
      tags: ['Transfer Offers'],
      responses: {
        '204': { description: 'Cancelled. The code no longer works.' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '409': {
          description: 'The offer has already been accepted, declined, cancelled or expired.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  },

  '/transfer-offers/{code}/accept': {
    parameters: [codeParam, { $ref: '#/components/parameters/OrganizationIdHeader' }],
    post: {
      operationId: 'acceptTransferOffer',
      summary: 'Take ownership of an offered device',
      description:
        'Moves the device into one of YOUR workspaces and runs the full transfer, including the ' +
        'cross-organization sweep. Requires `owner` or `admin` in the accepting organization.\n\n' +
        'Everything in `POST /devices/{id}/transfer` applies from here on: all historical ' +
        'telemetry and all recorded footage come with the device, the device does not have to be ' +
        'online, and `transfer.adoption` says whether it has confirmed the change yet.\n\n' +
        'Accepting is race-safe: the offer is claimed with a conditional write before the ' +
        'transfer runs, so only one of two simultaneous accepts wins. If the transfer itself ' +
        'fails the offer is put back to `pending` and the code can be retried.',
      tags: ['Transfer Offers'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['workspaceId'],
              properties: {
                workspaceId: {
                  type: 'string',
                  format: 'uuid',
                  description: 'The workspace in YOUR organization the device should land in.',
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Accepted and transferred.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['device', 'transfer', 'offer'],
                properties: {
                  device: { $ref: '#/components/schemas/Device' },
                  transfer: { $ref: '#/components/schemas/TransferSummary' },
                  offer: { $ref: '#/components/schemas/TransferOffer' },
                },
              },
            },
          },
        },
        '400': {
          description:
            'Malformed body, or the offer was created by your own organization (use ' +
            '`POST /devices/{id}/transfer` instead).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': {
          description:
            'No such offer, or the named workspace is not one of yours. Deliberately ' +
            'indistinguishable.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '409': {
          description:
            'The offer is already resolved or expired, the device is mid-transfer, a device ' +
            'with the same serial already exists in the destination workspace, or the offering ' +
            'organization no longer owns the device (the offer is stale).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        '502': {
          description:
            'The device could not be told about its new workspace. The transfer was rolled back ' +
            'and the offer is still open.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  },

  '/transfer-offers/{code}/decline': {
    parameters: [codeParam, { $ref: '#/components/parameters/OrganizationIdHeader' }],
    post: {
      operationId: 'declineTransferOffer',
      summary: 'Refuse an offered device',
      description:
        'Marks the offer `declined` and closes it. The sender sees the decline in ' +
        '`GET /transfer-offers`, so a refusal is an answer rather than an offer that quietly ' +
        'expires. Requires `owner` or `admin`.',
      tags: ['Transfer Offers'],
      responses: {
        '200': {
          description: 'Declined.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['offer'],
                properties: { offer: { $ref: '#/components/schemas/TransferOffer' } },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '409': {
          description: 'The offer is already resolved or expired.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  },
};
