import { TOOLS, JOB_STATES } from '@pdftools/shared';

/** OpenAPI document generated from the tool registry so docs never drift from the code. */
export function buildOpenApi(brand: string) {
  const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const paths: Record<string, unknown> = {};
  for (const t of TOOLS) {
    paths[`/api/pdf/${t.id}`] = {
      post: {
        tags: ['PDF tools'], summary: t.name, description: t.description,
        requestBody: { required: true, content: { 'multipart/form-data': { schema: {
          type: 'object', required: ['files'],
          properties: { files: { type: 'array', items: { type: 'string', format: 'binary' }, minItems: t.minFiles }, options: { type: 'string', description: 'JSON-encoded tool options' } },
        } } } },
        responses: { 202: { description: 'Job accepted', content: { 'application/json': { schema: { $ref: '#/components/schemas/JobAccepted' } } } }, 400: err, 413: err, 415: err, 429: err },
      },
    };
  }
  paths['/api/jobs/{jobId}'] = { get: { tags: ['Jobs'], summary: 'Get job status', parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Job' }, 404: err } } };
  paths['/api/jobs/{jobId}/cancel'] = { post: { tags: ['Jobs'], summary: 'Cancel a job', parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Job' }, 404: err } } };
  paths['/api/files/{fileId}/download'] = { get: { tags: ['Files'], summary: 'Download a result (short-lived signed link from the job)', parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'token', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'File' }, 403: err, 404: err } } };
  paths['/api/files/{fileId}'] = { delete: { tags: ['Files'], summary: 'Delete a result immediately', parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted' }, 404: err } } };
  return {
    openapi: '3.0.3',
    info: { title: `${brand} API`, version: '0.1.0', description: 'Upload files to a tool endpoint, receive a job id, poll the job, download the result. Guests are identified by an httpOnly cookie.' },
    paths,
    components: { schemas: {
      Error: { type: 'object', properties: { ok: { type: 'boolean', enum: [false] }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
      JobAccepted: { type: 'object', properties: { ok: { type: 'boolean' }, data: { type: 'object', properties: { jobId: { type: 'string' } } } } },
      JobState: { type: 'string', enum: [...JOB_STATES] },
    } },
  };
}
