import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const reputationRef = { $ref: '#/components/schemas/Reputation' };
const reputationPageRef = { $ref: '#/components/schemas/ReputationPage' };
const errorRef = { $ref: '#/components/schemas/Error' };
const err = (description: string) => ({ description, content: json(errorRef) });

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'TalentTrust API',
    version: config.version,
    description:
      'Milestone-based escrow API for freelancers and clients. State mirrors the TalentTrust ' +
      `Soroban escrow contract on Stellar ${config.network} (${config.contractId}). ` +
      `Explorer: ${explorerUrl()}. Data is held in memory and resets on redeploy.`,
  },
  servers: [{ url: '/' }],
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }],
  paths: {
    '/health': { get: { tags: ['System'], summary: 'Health check', responses: ok('Service is healthy') } },
    '/api/v1/chain': {
      get: { tags: ['System'], summary: 'On-chain escrow contract deployment info', responses: ok('Deployment') },
    },
    '/api/v1/stats': { get: { tags: ['System'], summary: 'Aggregate escrow statistics', responses: ok('Stats') } },
    '/api/v1/contracts': {
      get: {
        tags: ['Contracts'],
        summary: 'List escrow contracts',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'party', in: 'query', schema: { type: 'string' }, description: 'Client or freelancer address' },
        ],
        responses: ok('Contracts', { type: 'object', properties: { data: { type: 'array', items: contractRef } } }),
      },
      post: {
        tags: ['Contracts'],
        summary: 'Create an escrow contract',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['client', 'freelancer', 'milestones'],
            properties: {
              title: { type: 'string' },
              client: { type: 'string' },
              freelancer: { type: 'string' },
              token: { type: 'string', default: 'XLM' },
              milestones: {
                type: 'array',
                items: { type: 'object', properties: { title: { type: 'string' }, amount: { type: 'number' } } },
              },
            },
          }),
        },
        responses: { 201: { description: 'Created', content: json(contractRef) } },
      },
    },
    '/api/v1/contracts/{id}': {
      get: { tags: ['Contracts'], summary: 'Get a contract', parameters: [idParam], responses: ok('Contract', contractRef) },
    },
    '/api/v1/contracts/{id}/deposit': {
      post: {
        tags: ['Contracts'],
        summary: 'Deposit funds into escrow',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { amount: { type: 'number' } } }) },
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/milestones/{index}/release': {
      post: {
        tags: ['Contracts'],
        summary: 'Release a milestone payment to the freelancer',
        parameters: [idParam, { name: 'index', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/dispute': {
      post: {
        tags: ['Contracts'],
        summary: 'Open a dispute',
        parameters: [idParam],
        requestBody: {
          content: json({ type: 'object', properties: { raisedBy: { type: 'string' }, reason: { type: 'string' } } }),
        },
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        tags: ['Contracts'],
        summary: 'Resolve a dispute (admin)',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { freelancerBps: { type: 'integer' } } }) },
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: { tags: ['Contracts'], summary: 'Cancel and refund', parameters: [idParam], responses: ok('Updated contract', contractRef) },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['rating'],
            properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } },
          }),
        },
        responses: {
          ...ok('Reputation', reputationRef),
          400: err('Invalid contract id or rating'),
          404: err('Contract not found'),
          409: err('Contract is not completed or reputation already issued'),
        },
      },
    },
    '/api/v1/reputation': {
      get: {
        tags: ['Reputation'],
        summary: 'Ranked freelancer reputation leaderboard',
        parameters: [
          {
            name: 'sort',
            in: 'query',
            schema: { type: 'string', enum: ['score', 'completed', 'average'], default: 'score' },
            description: 'Sort order for the leaderboard',
          },
          {
            name: 'minCompleted',
            in: 'query',
            schema: { type: 'integer', minimum: 0, default: 1 },
            description: 'Minimum number of rated completed contracts',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            description: 'Page size (1..100)',
          },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string' },
            description: 'Opaque pagination cursor from a previous page response',
          },
        ],
        responses: {
          ...ok('Reputation leaderboard page', reputationPageRef),
          400: err('Invalid query parameter or cursor'),
        },
      },
    },
    '/api/v1/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Get freelancer reputation',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: ok('Reputation', reputationRef),
      },
    },
  },
  components: {
    schemas: {
      EscrowContract: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          client: { type: 'string' },
          freelancer: { type: 'string' },
          token: { type: 'string' },
          milestones: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                title: { type: 'string' },
                amount: { type: 'number' },
                released: { type: 'boolean' },
              },
            },
          },
          totalAmount: { type: 'number' },
          fundedAmount: { type: 'number' },
          releasedAmount: { type: 'number' },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
        },
      },
      Reputation: {
        type: 'object',
        required: [
          'address',
          'completedContracts',
          'totalRating',
          'averageRating',
          'score',
          'rank',
          'histogram',
          'lastRatedAt',
        ],
        properties: {
          address: { type: 'string' },
          completedContracts: { type: 'integer', minimum: 0 },
          totalRating: { type: 'integer', minimum: 0 },
          averageRating: { type: 'number', minimum: 0, maximum: 5 },
          score: { type: 'number', minimum: 0, maximum: 5 },
          rank: { type: 'integer', minimum: 1, nullable: true },
          histogram: {
            type: 'array',
            minItems: 5,
            maxItems: 5,
            items: { type: 'integer', minimum: 0 },
            description: 'Counts of [1★, 2★, 3★, 4★, 5★] ratings',
          },
          lastRatedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      ReputationPage: {
        type: 'object',
        required: ['data', 'page'],
        properties: {
          data: { type: 'array', items: reputationRef },
          page: {
            type: 'object',
            required: ['limit', 'nextCursor', 'hasMore'],
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 100 },
              nextCursor: { type: 'string', nullable: true },
              hasMore: { type: 'boolean' },
            },
          },
        },
      },
      Error: {
        type: 'object',
        required: ['error', 'message'],
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
};

export const docsHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TalentTrust API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>body{margin:0;background:#fafafa}.tt-bar{background:#0f172a;color:#fff;padding:14px 24px;font-family:system-ui,sans-serif;display:flex;gap:16px;align-items:center;flex-wrap:wrap}.tt-bar a{color:#a5b4fc}</style>
</head>
<body>
  <div class="tt-bar"><strong>TalentTrust API</strong>
    <a href="/">Endpoints (JSON)</a>
    <a href="/openapi.json">openapi.json</a>
    <a href="${config.frontendUrl}">Website</a>
    <a href="${explorerUrl()}">Escrow contract on stellar.expert</a>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
  <script>window.onload=function(){window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui'})}</script>
</body>
</html>`;
