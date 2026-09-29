# Sendery for JavaScript and TypeScript

Send published Sendery templates from JavaScript and TypeScript.

[Documentation](https://sendery.co/en/docs/javascript) · [API reference](https://sendery.co/en/docs/send-email) · [Changelog](CHANGELOG.md)

## Requirements

Node.js 22.12+. The package uses ES module imports and includes TypeScript types.

## Install

```bash
npm install @sendery/sdk
```

## Set up

Publish a `welcome` template with `name` and `action_url` variables, and create a [project API key](https://sendery.co/en/docs/authentication). Store it as `SENDERY_API_KEY` on your server. Use the SDK only on the server.

```bash
export SENDERY_API_KEY="your_project_api_key"
```

## Send an email

The response contains the accepted email’s `id` and `status`.

```javascript
import { Sendery } from '@sendery/sdk';

const apiKey = process.env.SENDERY_API_KEY;
if (!apiKey) throw new Error('Set SENDERY_API_KEY on your server.');

const sendery = new Sendery(apiKey);
const receipt = await sendery.send({
  to: 'alex@example.com',
  template: 'welcome',
  data: { name: 'Alex', action_url: 'https://example.com/start' },
});

console.log(receipt.id);
```

## Attachments

Use `attachment()` to create an attachment from file bytes. The helper handles base64 encoding.

Send up to 10 files totaling 5 MB. See the [attachment reference](https://sendery.co/en/docs/send-email#section-5) for supported formats and limits.

```javascript
import { Sendery, attachment } from '@sendery/sdk';
import { readFile } from 'node:fs/promises';

const sendery = new Sendery(process.env.SENDERY_API_KEY);
const file = await readFile('/path/document.pdf');

await sendery.prepare({
    to: 'alex@example.com',
    template: 'welcome',
    data: { name: 'Alex', action_url: 'https://example.com/start' },
    attachments: [attachment('document.pdf', file, 'application/pdf')],
}, 'welcome-attachment-123').retry().send();
```

In Next.js and Nuxt, use this in server-side routes or actions.

## Retrieve an email

Use the returned ID to [check delivery status](https://sendery.co/en/docs/get-email).

```javascript
const message = await sendery.get(receipt.id);
console.log(message.status);
```

## Retry a send

Use a key such as `welcome-123` for one email, and [keep the payload unchanged on retries](https://sendery.co/en/docs/idempotency). `retry(3)` allows up to three additional attempts for temporary failures; `send()` alone makes one attempt.

```javascript
const email = sendery.prepare({
  to: 'alex@example.com',
  template: 'welcome',
  data: { name: 'Alex', action_url: 'https://example.com/start' },
}, 'welcome-123');

const receipt = await email.retry(3).send();
```

## Handle errors

Catch the SDK exception to inspect the [status and code](https://sendery.co/en/docs/errors). Retry delays are in seconds. The example uses the prepared `email` from the [retry example above](#retry-a-send).

```javascript
import { SenderyError } from '@sendery/sdk';

try {
  const receipt = await email.retry(3).send();
  console.log(receipt.id);
} catch (error) {
  if (error instanceof SenderyError) {
    console.error(error.status, error.code, error.errors);
    // error.retryAfter is a delay in seconds, when provided.
  }
  throw error;
}
```

## Frameworks

Follow the server setup for [Next.js](https://sendery.co/en/docs/next) or [Nuxt](https://sendery.co/en/docs/nuxt).

## More

See [idempotency and retries](https://sendery.co/en/docs/idempotency) for retry conditions, delays, and reusing a key across attempts.

## License

[MIT](LICENSE).
