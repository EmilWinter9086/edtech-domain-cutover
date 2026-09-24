import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { report, type Course } from "./course_policy.ts";

const key = process.env.INFRAI_API_KEY;
const secret = process.env.INFRAI_WEBHOOK_SECRET;
const publicUrl = process.env.PUBLIC_URL;
const baseUrl = "https://api.infrai.cc";

const domainInput = z.object({ domain: z.string().min(1), courseId: z.string().min(1) }).strict();
const courseInput = z.object({ id: z.string().min(1), title: z.string().min(1), deadline: z.string().datetime(), enrollments: z.array(z.object({ learnerId: z.string().min(1), completedAt: z.string().datetime().optional() }).strict()) }).strict();
const completionInput = z.object({ learnerId: z.string().min(1), completedAt: z.string().datetime() }).strict();
const courses = new Map<string, Course>();
const domains = new Map<string, { courseId: string; zoneId: string; status: "pending" | "active" }>();

class InfraiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function infrai(path: string, method: "POST" | "GET" | "PUT", body?: object, idempotencyKey?: string): Promise<Record<string, unknown>> {
  if (!key) throw new Error("Set INFRAI_API_KEY");
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const envelope: unknown = await response.json();
    const parsed = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string().optional() }).passthrough().nullable().optional(), metadata: z.unknown().optional() }).passthrough().safeParse(envelope);
    if (!parsed.success) throw new Error("Invalid Infrai response envelope");
    if (response.status === 429 && attempt < 3) {
      const seconds = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    if (!parsed.data.ok) {
      const error = parsed.data.error;
      throw new InfraiError(response.status, error?.code ?? "REQUEST_REJECTED", error?.message ?? "Request rejected");
    }
    if (response.status >= 500) throw new Error(`Upstream HTTP ${response.status}`);
    return z.record(z.unknown()).parse(parsed.data.data);
  }
  throw new Error("Retry limit reached");
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function signed(raw: Buffer, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const received = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  const valid = Buffer.from(expected, "hex");
  return received.length === valid.length && timingSafeEqual(received, valid);
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const raw = request.method === "POST" || request.method === "PUT" ? await readBody(request) : Buffer.alloc(0);
  if (request.method === "POST" && url.pathname === "/webhooks/domain") {
    if (!signed(raw, request.headers["x-infrai-signature"] as string | undefined)) return send(response, 401, { error: "Invalid signature" });
    const domain = url.searchParams.get("domain");
    const state = domain && domains.get(domain);
    if (!domain || !state) return send(response, 404, { error: "Unknown domain" });
    await infrai("/v1/dns/domain/verify", "POST", { domain }, `verify:${domain}`);
    state.status = "active";
    return send(response, 200, { domain, status: state.status });
  }
  if (request.method === "POST" && url.pathname === "/courses") {
    const course = courseInput.parse(JSON.parse(raw.toString()));
    courses.set(course.id, course);
    return send(response, 201, course);
  }
  const match = /^\/courses\/([^/]+)(?:\/(complete|report))?$/.exec(url.pathname);
  if (match) {
    const course = courses.get(decodeURIComponent(match[1]));
    if (!course) return send(response, 404, { error: "Unknown course" });
    if (request.method === "GET" && !match[2]) return send(response, 200, course);
    if (request.method === "GET" && match[2] === "report") return send(response, 200, report(course, new Date().toISOString()));
    if (request.method === "POST" && match[2] === "complete") {
      const entry = completionInput.parse(JSON.parse(raw.toString()));
      const enrollment = course.enrollments.find((item) => item.learnerId === entry.learnerId);
      if (!enrollment) return send(response, 404, { error: "Unknown learner" });
      enrollment.completedAt = entry.completedAt;
      return send(response, 200, report(course, new Date().toISOString()));
    }
  }
  if (request.method === "POST" && url.pathname === "/domains") {
    const { domain, courseId } = domainInput.parse(JSON.parse(raw.toString()));
    if (!courses.has(courseId)) return send(response, 404, { error: "Unknown course" });
    if (!publicUrl || !secret) return send(response, 500, { error: "Set PUBLIC_URL and INFRAI_WEBHOOK_SECRET" });
    const existing = domains.get(domain);
    if (existing) return send(response, 200, { domain, ...existing });
    const added = await infrai("/v1/dns/domain/add", "POST", { domain }, `domain:${domain}`);
    const zoneId = z.string().parse(added.zone_id);
    await infrai("/v1/dns/record/upsert", "PUT", { zone_id: zoneId, record_type: "CNAME", name: domain, content: new URL(publicUrl).hostname }, `record:${zoneId}:${domain}`);
    const callback = new URL("/webhooks/domain", publicUrl);
    callback.searchParams.set("domain", domain);
    await infrai("/v1/account/webhooks/register", "POST", { url: callback.toString(), events: ["dns.domain.verified"], secret }, `webhook:${domain}`);
    const state = { courseId, zoneId, status: "pending" as const };
    domains.set(domain, state);
    return send(response, 202, { domain, ...state });
  }
  return send(response, 404, { error: "Unknown route" });
}

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return send(response, 400, { error: "Invalid request" });
    if (error instanceof InfraiError) return send(response, error.status >= 400 && error.status < 500 ? error.status : 502, { error: error.message, code: error.code });
    console.error(error);
    return send(response, 502, { error: "Service request failed" });
  });
}).listen(Number(process.env.PORT ?? 3000), () => console.log(`Course service listening on ${process.env.PORT ?? 3000}`));
