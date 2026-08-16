# Widget API Documentation

## Getting Started

The Widget API lets you create, update, and query widgets programmatically.
Base URL: `https://api.widgetco.example/v1`. All requests and responses use
JSON. Every endpoint requires the `Content-Type: application/json` header on
requests that carry a body.

A minimal request to list widgets:

```
GET /v1/widgets
Authorization: Bearer <api_key>
```

The response is a JSON object with a `data` array and a `next_cursor` field
for pagination. Widgets are returned newest first by default; pass
`?sort=oldest` to reverse the order.

## Authentication

All requests must include an `Authorization` header of the form
`Bearer <api_key>`. API keys are generated in the dashboard under
Settings → API Keys. Keys are scoped to a single workspace and cannot be
used across workspaces.

There are two kinds of keys: **live** keys (prefix `wk_live_`) which affect
real data, and **test** keys (prefix `wk_test_`) which operate against a
sandboxed copy of your workspace that resets nightly. Use test keys in CI.

Requests with a missing or malformed `Authorization` header receive a
`401 Unauthorized` response with `{"error": {"type": "authentication_error"}}`.
Requests with a valid but revoked key receive the same response. Rotate a
compromised key immediately from the dashboard — revocation takes effect
within a few seconds.

## Rate Limits

The API enforces a limit of 100 requests per minute per API key, and 1,000
requests per minute per workspace across all keys. Exceeding either limit
returns `429 Too Many Requests` with a `Retry-After` header giving the number
of seconds to wait before retrying.

Rate limit status is also reported on every response via three headers:

- `X-RateLimit-Limit` — the limit for this key
- `X-RateLimit-Remaining` — requests remaining in the current window
- `X-RateLimit-Reset` — unix timestamp when the window resets

Clients should back off exponentially on repeated 429s rather than retrying
immediately, since immediate retries tend to arrive right as the window
resets and can trigger the limit again in a burst. A jittered backoff
starting at 1 second and doubling up to 30 seconds is a reasonable default.

Bulk operations (batch create, batch update) count as a single request
against the rate limit regardless of how many widgets they touch, but are
capped at 500 widgets per batch call.

## Pagination

List endpoints are cursor-paginated, not offset-paginated. Each response
includes a `next_cursor` field; pass it as the `?cursor=` query parameter on
the next request to get the following page. A `next_cursor` of `null` means
there are no more pages.

Do not construct cursor values yourself — treat them as opaque tokens. Cursor
values are valid for 24 hours after being issued; a request with an expired
cursor returns `400 Bad Request` with `{"error": {"type": "invalid_cursor"}}`,
and you should restart pagination from the beginning.

The default page size is 25 and the maximum is 100, set via `?limit=`.
Requesting a limit above 100 is clamped to 100 rather than rejected.

## Errors

Errors follow a consistent shape:

```json
{"error": {"type": "string", "message": "string", "request_id": "string"}}
```

Common error types: `authentication_error` (401), `permission_error` (403),
`not_found_error` (404), `validation_error` (422), `rate_limit_error` (429),
and `internal_error` (500).

A `500 internal_error` means the failure was on our side. These are safe to
retry with backoff — the request was not applied. If a `500` persists across
three retries, include the `request_id` from the response body when contacting
support; it lets us trace the exact request server-side.

`422 validation_error` responses include a `fields` array describing which
input fields failed validation and why, so the client can surface field-level
errors without a second round trip.

## Webhooks

Webhooks notify your server when a widget is created, updated, or deleted.
Configure an endpoint URL in the dashboard under Settings → Webhooks. Each
event is POSTed as JSON with an `X-Widget-Signature` header — an HMAC-SHA256
of the raw request body using your webhook signing secret. Verify this
signature before trusting the payload; requests to your endpoint are not
otherwise authenticated.

Webhook deliveries are retried with exponential backoff for up to 24 hours if
your endpoint does not respond with a `2xx` status. After 24 hours of failed
deliveries, the webhook is automatically disabled and you'll receive an email
notification. Re-enable it from the dashboard once your endpoint is fixed.

Event payloads are versioned independently of the REST API. The current
webhook payload version is `2026-01-15`; include an `X-Widget-Webhook-Version`
header on your endpoint's responses if you need to signal which version your
handler expects during a migration.

## Best Practices

Cache widget data on your side when possible rather than polling the list
endpoint on a tight loop — prefer webhooks for change notifications and use
polling only as a fallback. When polling is unavoidable, use the `updated_at`
field to filter for changes since your last poll rather than re-fetching
everything.

Always check the `next_cursor` field rather than assuming a fixed number of
pages; the total widget count can change between your first and last page
request if items are created or deleted mid-pagination.

Use idempotency keys (the `Idempotency-Key` header) on create requests you
might retry, so a network timeout followed by a retry cannot accidentally
create the widget twice. Idempotency keys are honored for 24 hours.

## Changelog

**2026-06-01** — Added bulk batch endpoints for create and update, capped at
500 widgets per call.

**2026-03-15** — Webhook payload version `2026-01-15` introduced, adding a
`previous_attributes` field to `updated` events showing which fields changed.

**2025-11-02** — Rate limits raised from 60 to 100 requests per minute per
key, in response to customer feedback.

**2025-09-20** — Initial public release of the Widget API.
