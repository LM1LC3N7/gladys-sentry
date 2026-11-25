# Third-party notices

No third-party code is ported nor copied in this integration. It talks to
Sentry through its public HTTP API, written from the official documentation
(read on 2026-11-25):

- authentication: <https://docs.sentry.io/api/auth/> (`Authorization: Bearer`);
- pagination: <https://docs.sentry.io/api/pagination/> (`Link` header,
  `results="true|false"`);
- rate limits: <https://docs.sentry.io/api/ratelimits/>
  (`X-Sentry-Rate-Limit-Remaining`, `X-Sentry-Rate-Limit-Reset`);
- the project list:
  <https://docs.sentry.io/api/organizations/list-an-organizations-projects/>;
- the issues:
  <https://docs.sentry.io/api/events/list-an-organizations-issues/>;
- the error counts:
  <https://docs.sentry.io/api/organizations/retrieve-event-counts-for-an-organization-v2/>;
- the regions: <https://docs.sentry.io/organization/data-storage-location/>
  (`sentry.io`, `de.sentry.io`).

Sentry itself is published under the Functional Source License (FSL-1.1,
converting to Apache-2.0 after two years). This integration only calls the
API of a Sentry the user already has (sentry.io or self-hosted): no Sentry
code is included, run nor redistributed.

Sentry is a trademark of Functional Software, Inc. This integration is
unofficial and not affiliated with Sentry.

The only runtime dependency, `@gladysassistant/integration-sdk`, is
Apache-2.0 and installed by npm.
