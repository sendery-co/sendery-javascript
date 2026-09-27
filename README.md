# Sendery — JavaScript & TypeScript integration

Send template emails from JavaScript & TypeScript with the Sendery SDK.

MIT licensed. Repository: https://github.com/sendery-co/sendery-javascript

Documentation: https://sendery.co/en/docs/javascript

## Install

```
npm install @sendery/sdk
```

## Install

Node.js 22.12+

## Server-side only

Read SENDERY_API_KEY from the server environment. Import Sendery from @sendery/sdk. The package includes TypeScript declarations and uses the runtime’s fetch API.

## Handle failures

Catch SenderyError to inspect status, code, errors, and retryAfter. prepare() captures a fixed payload; retry() reuses its generated idempotencyKey. Use get(id) to retrieve status.

## Example

```
import { Sendery } from '@sendery/sdk';

const sendery = new Sendery(process.env.SENDERY_API_KEY);
const email = sendery.prepare({
  to: 'alex@example.com',
  template: 'welcome',
  data: { name: 'Alex' },
});
const receipt = await email.retry(3).send();
```

## Retries and queues

Reuse a prepared email for retries. New requests receive new keys; when reconstructing a request in another process, supply the original key and unchanged data. Keep API keys server-side. Framework mailers send Sendery templates, not arbitrary HTML or attachments.
