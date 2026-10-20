import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const errorRef = { $ref: '#/components/schemas/ErrorResponse' };
const txStatusRef = { $ref: '#/components/schemas/TxStatusResponse' };
const relayedTxRef = { $ref: '#/components/schemas/RelayedTransaction' };

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
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }, { name: 'Transactions' }],
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
        requestBody: { content: json({ type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } } }) },
        responses: ok('Reputation'),
      },
    },
    '/api/v1/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Get freelancer reputation',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: ok('Reputation'),
      },
    },
    '/api/v1/tx/submit': {
      post: {
        tags: ['Transactions'],
        summary: 'Validate and relay a signed Soroban escrow transaction to RPC',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['xdr'],
            properties: {
              xdr: {
                type: 'string',
                description: 'Base64-encoded signed TransactionEnvelope XDR targeting the configured escrow contract',
              },
            },
          }),
        },
        responses: {
          200: {
            description: 'Transaction was already known (DUPLICATE); returns current status',
            content: json(txStatusRef),
          },
          202: {
            description: 'Transaction accepted and pending inclusion in a ledger',
            content: json({
              type: 'object',
              required: ['hash', 'status'],
              properties: {
                hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                status: { type: 'string', enum: ['PENDING'] },
              },
            }),
          },
          400: {
            description: 'Invalid transaction XDR or failed escrow contract validation rules',
            content: json(errorRef),
          },
          422: {
            description: 'Transaction rejected by Soroban RPC (submission_failed)',
            content: json({
              type: 'object',
              required: ['error', 'message', 'code'],
              properties: {
                error: { type: 'string', enum: ['submission_failed'] },
                message: { type: 'string' },
                code: { type: 'string', description: 'Decoded TransactionResultCode (e.g. txBadSeq, txInsufficientFee)' },
                hash: { type: 'string' },
              },
            }),
          },
          503: {
            description: 'Soroban RPC returned TRY_AGAIN_LATER',
            headers: {
              'Retry-After': {
                description: 'Seconds to wait before retrying submission',
                schema: { type: 'integer' },
              },
            },
            content: json(errorRef),
          },
        },
      },
    },
    '/api/v1/tx': {
      get: {
        tags: ['Transactions'],
        summary: 'List recent relayed escrow transactions from the bounded LRU cache',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum number of recent transactions to return (default 20)',
            schema: { type: 'integer', minimum: 1, maximum: config.txCacheMax, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'Recent relayed transactions (most recent first)',
            content: json({
              type: 'object',
              required: ['data'],
              properties: {
                data: { type: 'array', items: relayedTxRef },
              },
            }),
          },
          400: {
            description: 'Invalid limit parameter',
            content: json(errorRef),
          },
        },
      },
    },
    '/api/v1/tx/{hash}': {
      get: {
        tags: ['Transactions'],
        summary: 'Get transaction status, decoded returnValue, and contract error details',
        parameters: [
          {
            name: 'hash',
            in: 'path',
            required: true,
            description: '64-character hex transaction hash',
            schema: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
          },
          {
            name: 'wait',
            in: 'query',
            required: false,
            description: 'If true, long-polls up to 20s (every 1s) until transaction leaves PENDING/NOT_FOUND',
            schema: { type: 'boolean', default: false },
          },
        ],
        responses: {
          200: {
            description: 'Transaction status and decoded result',
            content: json(txStatusRef),
          },
          400: {
            description: 'Invalid transaction hash format',
            content: json(errorRef),
          },
          503: {
            description: 'Too many concurrent long-poll requests',
            content: json(errorRef),
          },
        },
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
      RelayedTransaction: {
        type: 'object',
        required: ['hash', 'function', 'submittedAt'],
        properties: {
          hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          function: { type: 'string' },
          submittedAt: { type: 'string', format: 'date-time' },
        },
      },
      ContractError: {
        type: 'object',
        required: ['name', 'code'],
        properties: {
          name: { type: 'string', description: 'EscrowError variant name (e.g. InvalidAmount, OverFunded)' },
          code: { type: 'integer', description: 'Numeric contract error code (1..16)' },
        },
      },
      TxStatusResponse: {
        type: 'object',
        required: ['hash', 'status', 'ledger', 'createdAt', 'function', 'returnValue'],
        properties: {
          hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          status: { type: 'string', enum: ['PENDING', 'SUCCESS', 'FAILED', 'NOT_FOUND'] },
          ledger: { type: 'integer', nullable: true },
          createdAt: { oneOf: [{ type: 'integer' }, { type: 'string' }], nullable: true },
          function: { type: 'string', nullable: true },
          returnValue: {
            nullable: true,
            description: 'Decoded native return value via scValToNative (bigints serialized as strings)',
          },
          contractError: { $ref: '#/components/schemas/ContractError' },
        },
      },
      ErrorResponse: {
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
