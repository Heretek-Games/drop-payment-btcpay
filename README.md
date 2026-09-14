# BTCPay Server

BTCPay Server cryptocurrency payment gateway plugin for Drop indie commerce
(#21).

## Build

```sh
npm ci
npm run build
npm test
npm run typecheck
```

## Configuration

There is **no placeholder default**: the gateway refuses to build API calls
until a real deployment URL is configured. Configuration is read from plugin
storage first, then the environment:

| Setting | Storage key | Environment variable |
| :--- | :--- | :--- |
| API base URL (e.g. `https://btcpayserver.example.org/api/v1`) | `apiBaseUrl` | `BTCPAY_BASE_URL` |
| Store id (e.g. the id from BTCPay's store settings) | `storeId` | `BTCPAY_STORE_ID` |
| API key (Bearer) | - | `BTCPAY_API_KEY` |
| Webhook signing secret | `webhookSecret` | `BTCPAY_WEBHOOK_SECRET` |

Without a store id the gateway still registers, but every `createPaymentIntent`
call is rejected: BTCPay invoices are store-scoped.

Without a webhook secret the gateway still registers, but every
`handleWebhook` call is rejected: verification fails closed rather than
accepting unsigned events.

## API behaviour

- `createPaymentIntent` posts JSON to
  `${apiBaseUrl}/stores/${storeId}/invoices` (the BTCPay Greenfield
  `Invoices_CreateInvoice` endpoint) with `orderId`, `amount`, `currency`, and
  `metadata.orderId`, then maps `checkoutLink`/`url` and the invoice status.
  `apiBaseUrl` should be the API root (e.g. `.../api/v1`), **not** include a
  store id.
- `handleWebhook` verifies the `BTCPay-Sig` header first: HMAC-SHA256 over the
  raw body with the webhook secret, compared in constant time (`sha256=` prefix
  or bare hex are both accepted). Event types `InvoiceSettled`,
  `InvoicePaymentSettled`, `InvoicePaidInFull`, `InvoiceExpired`,
  `InvoiceInvalid`, `InvoiceRefunded` are mapped; legacy invoice payloads are
  mapped via `status`/`posData`. Unsupported events throw instead of being
  treated as successful.

## Host requirements

The host must pass the **raw request body** (string or bytes) to
`handleWebhook`; re-serialized JSON is documented as best-effort only. Header
names are matched case-insensitively.
