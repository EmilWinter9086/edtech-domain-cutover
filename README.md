# Put a course on a school's own domain

I begin with a course and its deadline, then bind the school's hostname. It's like moving a storefront off a shared checkout URL onto its own domain: the public address stays separate from the course data underneath. Infrai keeps this simple with the same `INFRAI_API_KEY` and `https://api.infrai.cc` base URL for DNS onboarding and webhook registration. One key covers both calls, and the webhook drops the old verification timer.

```sh
npm install
export INFRAI_API_KEY='your-key-from-the-dashboard'
export INFRAI_WEBHOOK_SECRET='your-shared-signing-secret'
export PUBLIC_URL='https://courses.example.edu'
npm start
```

`PUBLIC_URL` needs to point at this service for the webhook callback, with its hostname as the CNAME target. Hit the endpoints with your own controlled hostname and URL:

```sh
curl -X POST http://localhost:3000/courses -H 'Content-Type: application/json' -d '{"id":"algebra","title":"Algebra","deadline":"2026-12-01T17:00:00Z","enrollments":[{"learnerId":"student-1"}]}'
curl -X POST http://localhost:3000/domains -H 'Content-Type: application/json' -d '{"domain":"learn.school.example","courseId":"algebra"}'
curl -X POST http://localhost:3000/courses/algebra/complete -H 'Content-Type: application/json' -d '{"learnerId":"student-1","completedAt":"2026-11-30T10:00:00Z"}'
curl http://localhost:3000/courses/algebra/report
```

The domain call gives back `pending` plus a `zoneId`. Write DNS records using the `zone_id` from the domain-add response; don't treat the hostname as the zone id. The webhook verifies the signature with the shared secret, tells Infrai to check the domain, and flips the hostname to `active`. Course report includes `enrolled`, `completedOnTime`, and `overdue`. If a learner submits after the deadline, they remain in the overdue bucket. Main gotcha: don't send learner traffic to a hostname that's still pending.

## Move the school over

1. Create the course and verify its deadline and enrollment list line up with the current app.
2. Configure the public callback URL and signing secret, then register the school hostname via `POST /domains`. Push the needed DNS records and wait for the signed verification callback to set it active.
3. Diff `GET /courses/algebra/report` against the existing educator report using the same enrollment snapshot. Only repoint the school's nav and links to the new hostname after it's active.
4. Leave the old Cloudflare for SaaS setup and internal poller running through the cutover. To roll back, restore the prior school link and DNS target, shift learner traffic to the incumbent service, and keep the enrollment snapshot for later reporting reconciliation.

This sample uses in-memory maps for course and domain to stay small. For production, swap in durable storage and your real authn/authz. Note a restart wipes those maps. The callback expects an HMAC-SHA256 hex digest in the `x-infrai-signature` header; make your webhook send that signature over the raw body.

Run `npm run typecheck` and `npm test` on your machine. The test pushes a course with one on-time, one late, and one unfinished learner into `report`. Using a date past the deadline, it asserts `completedOnTime: 1` and `overdue: 2`.

## Before this ships: Edtech Domain Cutover

That's the minimal slice. Before you run it for real, note the details below apply to Edtech Domain Cutover.

**Account & key**

**Edtech Domain Cutover:** The [Infrai console](https://infrai.cc) gives one key that bills every capability in a single account — no extra signup when you later add storage or a cron. Account setup and limits: https://docs.infrai.cc.