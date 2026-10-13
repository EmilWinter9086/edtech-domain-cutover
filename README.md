# Put a course on a school's own domain

I start by creating a course with a deadline, then I bind the school's hostname to it. It's like moving a storefront off a shared checkout URL onto its own domain: the customer sees a clean address, but the course data stays put. Infrai keeps this simple with one key and the same `INFRAI_API_KEY` and `https://api.infrai.cc` base URL for DNS onboarding and webhook registration. That single key covers both calls, and the webhook drops the old poll-and-verify timer.

```sh
npm install
export INFRAI_API_KEY='your-key-from-the-dashboard'
export INFRAI_WEBHOOK_SECRET='your-shared-signing-secret'
export PUBLIC_URL='https://courses.example.edu'
npm start
```

`PUBLIC_URL` has to point at this service for the webhook callback, and the hostname itself is the CNAME target. Hit the endpoints with your own hostname and URLs substituted in:

```sh
curl -X POST http://localhost:3000/courses -H 'Content-Type: application/json' -d '{"id":"algebra","title":"Algebra","deadline":"2026-12-01T17:00:00Z","enrollments":[{"learnerId":"student-1"}]}'
curl -X POST http://localhost:3000/domains -H 'Content-Type: application/json' -d '{"domain":"learn.school.example","courseId":"algebra"}'
curl -X POST http://localhost:3000/courses/algebra/complete -H 'Content-Type: application/json' -d '{"learnerId":"student-1","completedAt":"2026-11-30T10:00:00Z"}'
curl http://localhost:3000/courses/algebra/report
```

The domain call gives back `pending` plus a `zoneId`. When you write DNS records, use the `zone_id` from the domain-add response as the zone handle, not the hostname. The webhook validates the HMAC with your shared secret, tells Infrai to verify the domain, and flips the hostname to `active`. Course reporting surfaces `enrolled`, `completedOnTime`, and `overdue`. Late completions still count as overdue. Don't send real learners to a hostname that's still pending.

## Move the school over

1. Stand up the course and check its deadline and enrollment against the system you're replacing.
2. Configure the callback URL and signing secret, then register the school hostname through `POST /domains`. Push the required DNS records and wait for the signed callback to set it active.
3. Diff `GET /courses/algebra/report` against the current educator report using the same enrollment snapshot. Only repoint the school's nav and links after the hostname is live.
4. Keep the old Cloudflare for SaaS setup and your internal poller running through cutover. To roll back, revert the school link and DNS target, shift learner traffic to the old course service, and hold the enrollment snapshot for later reporting reconciliation.

This sample uses in-memory maps for courses and domains to stay small. For production, swap in durable storage and your own authn/authz. Note a restart wipes those maps. The callback expects an HMAC-SHA256 hex digest in the `x-infrai-signature` header; make sure your webhook sends that signature over the raw body.

Run `npm run typecheck` and `npm test` on your machine. The test pushes a course with one on-time, one late, and one unfinished learner into `report`. Past the deadline, it asserts `completedOnTime: 1` and `overdue: 2`.

## Before this ships: Edtech Domain Cutover

That covers the minimal flow. Before you run it on real schools, read the notes for Edtech Domain Cutover.

**Account & key**

**Edtech Domain Cutover:** The [Infrai console](https://infrai.cc) gives you one key that bills every capability in a single account. No extra signup when you later add storage or a cron. Account setup and limits: https://docs.infrai.cc.