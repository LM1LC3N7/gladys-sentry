# gladys-sentry

[Gladys Assistant](https://gladysassistant.com) external integration for
**Sentry** (sentry.io in the US or the EU, or a self-hosted Sentry): each
project of your organization becomes a device with its unresolved issues,
its errors of the last hour and of the last 24 hours and its newest issue,
and two scene triggers, "New Sentry issue" and "Sentry error spike". Read
only, through the official Sentry API, with a personal auth token.

Unofficial, not affiliated with Sentry. **Never tested with a real Sentry**:
written from the official API documentation, tested against a simulated
Sentry.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Built on [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
  0.16; Gladys 5.1.0 or later (scene triggers).

## Development

```bash
npm install
npm test               # node --test, against the SDK's fake Gladys and a fake Sentry
npm run lint
npm run format:check
npm run cover          # regenerates cover.png
npm run validate:manifest
node scripts/mutants.mjs   # mutation check of the guards (slow, one at a time)
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules, and
[TODO.md](TODO.md) for the decisions and what comes next.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Sentry itself is under the Functional Source License: this integration only
calls its API, no Sentry code is included.
