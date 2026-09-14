# AGENTS.md — drop-payment-btcpay

BTCPay Server cryptocurrency payment gateway plugin for Drop (#21).

## Toolchain

- Node >= 22, pnpm 10+
- `pnpm install`, `pnpm build`, `pnpm test`

## Contract

Built on [`@droposs/plugin-sdk`](https://github.com/Heretek-Games/drop-plugin-sdk)
(plugin API v2). The local dependency resolves the sibling checkout at
`../drop-plugin-sdk/packages/plugin-sdk` so the workspace builds before the
SDK is republished to npm.
