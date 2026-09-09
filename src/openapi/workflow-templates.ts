/**
 * The READ half of the workflow-templates surface.
 *
 * Only three operations are here, and `src/openapi/scope.ts` explains why: a
 * program discovers templates by tag and reads one back, while authoring stays
 * in the editor and out of this document.
 */
export const workflowTemplatesPaths = {
  '/workflow-templates': {
    get: {
      operationId: 'listWorkflowTemplates',
      summary: 'List workflow templates',
      description:
        'Every template in the active organization, newest-updated first. Paginated with the ' +
        'shared list dialect, and filterable by `status` and by `tag`.\n\n' +
        '`tag` is what makes this endpoint useful to a program: tag the templates your ' +
        'integration owns, then find them by that tag rather than by name or id. Repeating the ' +
        'parameter and comma-separating its values are the same request, and the semantics are ' +
        'ANY-of: `?tag=geofence&tag=speeding` returns templates carrying EITHER. There is no ' +
        'ALL-of mode.\n\n' +
        'Rows carry the metadata and the tags, not the graph. Read one template to get its ' +
        'versions and their definitions.',
      tags: ['Workflow Templates'],
      parameters: [
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        { $ref: '#/components/parameters/OrderQuery' },
        {
          name: 'sort',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['updatedAt', 'createdAt', 'name'], default: 'updatedAt' },
          description: 'Sort column. Anything else is a 400.',
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['draft', 'published'] },
          description:
            'Narrow to one status. Empty or `any` means no filter; anything else is a 400.',
        },
        {
          name: 'tag',
          in: 'query',
          required: false,
          explode: true,
          style: 'form',
          schema: {
            type: 'array',
            items: { $ref: '#/components/schemas/WorkflowTemplateTag' },
            maxItems: 20,
          },
          description:
            'Return templates carrying at least one of these tags (ANY-of). Values are ' +
            'normalized like stored tags, so `?tag=Geofence` matches `geofence`; a value that ' +
            'cannot be a tag at all is a 400. At most 20 values.',
          example: ['geofence'],
        },
      ],
      responses: {
        '200': {
          description: 'List of workflow templates',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['templates', 'page'],
                properties: {
                  templates: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/WorkflowTemplate' },
                  },
                  page: { $ref: '#/components/schemas/PageMeta' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/workflow-templates/tags': {
    get: {
      operationId: 'listWorkflowTemplateTags',
      summary: "List the organization's workflow template tags",
      description:
        'Every distinct tag used in the active organization with the number of templates ' +
        'carrying it, most used first and alphabetical within a count. One query over the ' +
        "organization's templates, meant for populating a picker without paging the collection. " +
        'An organization whose templates are all untagged gets an empty array.',
      tags: ['Workflow Templates'],
      responses: {
        '200': {
          description: 'The tag vocabulary of this organization',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tags'],
                properties: {
                  tags: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/WorkflowTemplateTagCount' },
                  },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/workflow-templates/{id}': {
    parameters: [{ $ref: '#/components/parameters/IdPath' }],
    get: {
      operationId: 'getWorkflowTemplate',
      summary: 'Get a workflow template',
      description:
        'The template plus its full version history and the devices it is attached to. Each ' +
        "version carries its graph in `definition`, in the engine's definition format, upgraded " +
        'to the current schema version on read.\n\n' +
        'A template belonging to another organization answers `404`, like every other ' +
        'org-scoped resource: you cannot tell "does not exist" from "not yours".',
      tags: ['Workflow Templates'],
      responses: {
        '200': {
          description: 'Workflow template',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['template'],
                properties: {
                  template: { $ref: '#/components/schemas/WorkflowTemplateDetail' },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
};
