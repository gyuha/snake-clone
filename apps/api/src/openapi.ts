/** Public REST contract used by clients, mocks, and SDK generators. */
const json = { type: 'object', additionalProperties: true };
const error = { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string', format: 'uuid' } } };
const bearer = [{ bearerAuth: [] }];
const session = { type: 'object', additionalProperties: false, required: ['userId', 'accessToken'], properties: { userId: { type: 'string', format: 'uuid' }, accessToken: { type: 'string' }, refreshToken: { type: 'string' } } };
const ticket = { type: 'object', additionalProperties: false, required: ['ticketId', 'mode', 'roomName', 'endpoint', 'region', 'capacity', 'joinToken', 'expiresAt'], properties: { ticketId: { type: 'string', format: 'uuid' }, mode: { type: 'string' }, roomName: { type: 'string' }, endpoint: { type: 'string', format: 'uri' }, region: { type: 'string' }, capacity: { type: 'integer', minimum: 1 }, joinToken: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' } } };
const profile = { type: 'object', additionalProperties: false, required: ['userId', 'accountType', 'nickname', 'selectedSkinId', 'identities', 'stats'], properties: { userId: { type: 'string', format: 'uuid' }, accountType: { enum: ['guest', 'account'] }, nickname: { type: ['string', 'null'] }, selectedSkinId: { type: 'integer' }, identities: { type: 'array', items: { type: 'string' } }, stats: { type: 'object', additionalProperties: false, required: ['games', 'bestScore', 'bestSurvivalMs', 'totalKills'], properties: { games: { type: 'integer' }, bestScore: { type: 'number' }, bestSurvivalMs: { type: 'integer' }, totalKills: { type: 'integer' } } } } };

export const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Serpent Arena API', version: 'v1', description: 'Public REST contract for the Serpent Arena web client.' },
  servers: [{ url: '/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: { Error: error, Session: session, MatchTicket: ticket, Profile: profile },
    headers: { RequestId: { schema: { type: 'string', format: 'uuid' }, description: 'Correlates logs, errors, and support reports.' } },
  },
  paths: {
    '/auth/guest': { post: { summary: 'Create anonymous session', responses: { '201': { description: 'Guest session', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } }, '429': { description: 'Rate limited' } } } },
    '/auth/refresh': { post: { summary: 'Rotate refresh token and issue access token', responses: { '200': { description: 'Session', content: { 'application/json': { schema: json } } }, '401': { description: 'Invalid refresh token' } } } },
    '/auth/link': { post: { summary: 'Link verified identity to guest progress', security: bearer, responses: { '200': { description: 'Linked account' }, '403': { description: 'Identity verifier unavailable' } } } },
    '/me': { get: { summary: 'Get profile and match statistics', security: bearer, responses: { '200': { description: 'Profile', content: { 'application/json': { schema: json } } } } }, patch: { summary: 'Update nickname/settings', security: bearer, responses: { '200': { description: 'Updated profile' }, '400': { description: 'Validation error' } } }, delete: { summary: 'Delete/anonymize account data', security: bearer, responses: { '204': { description: 'Deleted' } } } },
    '/cosmetics': { get: { summary: 'List skin catalog and ownership', security: bearer, responses: { '200': { description: 'Catalog' } } } },
    '/me/loadout': { put: { summary: 'Select owned skin', security: bearer, responses: { '200': { description: 'Saved loadout' }, '403': { description: 'Skin not owned' } } } },
    '/matches/tickets': { post: { summary: 'Issue one-time quick-match ticket', security: bearer, responses: { '201': { description: 'Room endpoint and join token', content: { 'application/json': { schema: { $ref: '#/components/schemas/MatchTicket' } } } }, '503': { description: 'No compatible room' } } } },
    '/leaderboards/{scope}': { get: { summary: 'Get daily, weekly, or all-time leaderboard', parameters: [{ name: 'scope', in: 'path', required: true, schema: { enum: ['daily', 'weekly', 'all'] } }], responses: { '200': { description: 'Leaderboard' } } } },
    '/config/client': { get: { summary: 'Get public active game configuration', responses: { '200': { description: 'Versioned client config' } } } },
    '/reports': { post: { summary: 'Submit player report', security: bearer, responses: { '201': { description: 'Report accepted' }, '429': { description: 'Rate limited' } } } },
    '/telemetry/batch': { post: { summary: 'Submit best-effort product telemetry', security: bearer, responses: { '202': { description: 'Accepted' }, '429': { description: 'Rate limited' } } } },
  },
} as const;
