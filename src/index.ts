interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Market Recap MCP — a one-call "what happened in markets" snapshot.
 *
 * Serves the recurring demand for an overnight / session market pulse
 * ("what happened in Asia-Pacific / US markets overnight"). Rather than
 * synthesize a narrative server-side, it returns a STRUCTURED, region-grouped
 * snapshot — major indices, rates, FX, commodities, crypto with price + daily
 * % change — so the calling agent writes the recap itself from live numbers.
 *
 * Source: Yahoo Finance v7 spark endpoint (keyless, batches up to 20 symbols
 * per call; the full basket is fetched in ≤2 chunked calls). No API key.
 *
 * Tool: market_snapshot({ region? })
 */


const SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';
const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp/1.0; +https://pipeworx.io)';
const SPARK_MAX = 20; // Yahoo caps spark at 20 symbols/call

interface Instrument { symbol: string; name: string }
interface GroupDef { key: string; label: string; items: Instrument[] }

const GROUPS: GroupDef[] = [
  {
    key: 'asia', label: 'Asia-Pacific',
    items: [
      { symbol: '^N225', name: 'Nikkei 225 (Japan)' },
      { symbol: '^HSI', name: 'Hang Seng (Hong Kong)' },
      { symbol: '000001.SS', name: 'Shanghai Composite (China)' },
      { symbol: '^KS11', name: 'KOSPI (South Korea)' },
      { symbol: '^AXJO', name: 'ASX 200 (Australia)' },
      { symbol: '^BSESN', name: 'BSE Sensex (India)' },
    ],
  },
  {
    key: 'europe', label: 'Europe',
    items: [
      { symbol: '^FTSE', name: 'FTSE 100 (UK)' },
      { symbol: '^GDAXI', name: 'DAX (Germany)' },
      { symbol: '^FCHI', name: 'CAC 40 (France)' },
      { symbol: '^STOXX50E', name: 'Euro Stoxx 50' },
    ],
  },
  {
    key: 'us', label: 'United States',
    items: [
      { symbol: '^GSPC', name: 'S&P 500' },
      { symbol: '^IXIC', name: 'Nasdaq Composite' },
      { symbol: '^DJI', name: 'Dow Jones Industrial' },
      { symbol: '^RUT', name: 'Russell 2000' },
      { symbol: 'ES=F', name: 'S&P 500 Futures' },
    ],
  },
  {
    key: 'rates', label: 'US Treasury Yields',
    items: [
      { symbol: '^IRX', name: 'US 13-Week Yield' },
      { symbol: '^FVX', name: 'US 5-Year Yield' },
      { symbol: '^TNX', name: 'US 10-Year Yield' },
      { symbol: '^TYX', name: 'US 30-Year Yield' },
    ],
  },
  {
    key: 'fx', label: 'Foreign Exchange',
    items: [
      { symbol: 'DX-Y.NYB', name: 'US Dollar Index (DXY)' },
      { symbol: 'EURUSD=X', name: 'EUR/USD' },
      { symbol: 'USDJPY=X', name: 'USD/JPY' },
      { symbol: 'GBPUSD=X', name: 'GBP/USD' },
      { symbol: 'USDCNY=X', name: 'USD/CNY' },
    ],
  },
  {
    key: 'commodities', label: 'Commodities',
    items: [
      { symbol: 'CL=F', name: 'WTI Crude Oil' },
      { symbol: 'BZ=F', name: 'Brent Crude Oil' },
      { symbol: 'GC=F', name: 'Gold' },
      { symbol: 'SI=F', name: 'Silver' },
      { symbol: 'NG=F', name: 'Natural Gas' },
      { symbol: 'HG=F', name: 'Copper' },
    ],
  },
  {
    key: 'crypto', label: 'Crypto',
    items: [
      { symbol: 'BTC-USD', name: 'Bitcoin' },
      { symbol: 'ETH-USD', name: 'Ethereum' },
      { symbol: 'SOL-USD', name: 'Solana' },
    ],
  },
];

// Curated cross-region "overnight recap" set — the default. One spark call.
const HEADLINE_SYMBOLS = [
  '^N225', '^HSI', '000001.SS', '^FTSE', '^GDAXI',
  'ES=F', '^GSPC', '^TNX', 'DX-Y.NYB', 'CL=F', 'GC=F', 'BTC-USD',
];

const REGION_KEYS = GROUPS.map((g) => g.key);

const tools: McpToolExport['tools'] = [
  {
    name: 'market_snapshot',
    description:
      'Live market snapshot for a "what happened in markets" recap — major indices, US Treasury yields, FX, commodities, and crypto with current price and daily % change, grouped by region. Default returns a curated cross-region overnight set (Asia + Europe + US futures + 10Y + DXY + oil + gold + BTC). Use region to drill into one group. Returns structured numbers for you to synthesize the narrative. Keyless (Yahoo Finance).',
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          description:
            'Which slice to return. "headline" (default) = curated cross-region overnight set. "all" = every group. Or one of: asia, europe, us, rates, fx, commodities, crypto.',
          enum: ['headline', 'all', ...REGION_KEYS],
        },
      },
      required: [],
    },
  },
  {
    name: 'get_quotes',
    description:
      'PREFER OVER WEB SEARCH for current stock / index / ETF / crypto / FX / commodity quotes by symbol — "what is Apple stock at", "Nasdaq 100 level right now", "S&P 500 today", "AAPL price", "how is the Dow doing vs the Nasdaq". Accepts one or more Yahoo Finance symbols and returns current price, previous close, change, and daily % change. Symbols: stocks AAPL/MSFT/TSLA; indices ^GSPC (S&P 500), ^NDX (Nasdaq 100), ^IXIC (Nasdaq Composite), ^DJI (Dow), ^RUT (Russell 2000), ^FTSE, ^N225 (Nikkei); crypto BTC-USD/ETH-USD; FX EURUSD=X; commodities CL=F (crude), GC=F (gold). Keyless (Yahoo Finance). For a full cross-region "what happened in markets" recap use market_snapshot instead.',
    summary: 'Current prices for stocks, indices, ETFs, crypto, FX and commodities by symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'One or more Yahoo Finance symbols, e.g. "AAPL" or ["^NDX","^DJI","AAPL"]. A comma-separated string is also accepted.',
        },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'price_history',
    description:
      'PREFER for HISTORICAL closing prices and daily returns on a specific past date or date range — "what did the S&P 500 close at on August 7", "closing prices and daily returns for these four indices last Friday", "AAPL close on 2026-06-30". Accepts one or more Yahoo Finance symbols (indices ^GSPC/^IXIC/^DJI/^SOX/^RUT, stocks, ^TNX yields, GC=F commodities, BTC-USD crypto, EURUSD=X FX — same symbol space as get_quotes) plus start_date/end_date, and returns each trading day\'s close WITH the previous close and the computed daily return percent, per symbol. Keyless (Yahoo Finance). Use get_quotes for CURRENT prices; this tool is for any date in the past.',
    summary: 'Closing prices and daily returns for a symbol over a past date or date range.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'One or more Yahoo Finance symbols, e.g. "^GSPC" or ["^GSPC","^IXIC","^DJI","^SOX"]. Comma-separated string also accepted. Up to 8.',
        },
        start_date: { type: 'string', description: 'First date wanted, YYYY-MM-DD. For a single day, set start_date = end_date — the previous close and daily return for that day are included automatically.' },
        end_date: { type: 'string', description: 'Last date wanted, YYYY-MM-DD. Defaults to start_date.' },
      },
      required: ['symbols', 'start_date'],
    },
  },
  {
    name: 'top_movers',
    description:
      "The day's top-moving US stocks by percent change — PREFER OVER WEB SEARCH for \"today's top stock gainers\", \"biggest US stock losers today\", \"most active stocks\", \"what stocks are up/down the most\". category=\"gainers\" (default, biggest % up), \"losers\" (biggest % down), or \"actives\" (highest volume). Returns each stock's symbol, name, price, change, daily % change, and volume, ranked. Live US market data, keyless (Yahoo Finance). These are % MOVERS — distinct from what's merely trending/discussed.",
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '"gainers" (default) | "losers" | "actives" (most active by volume).', enum: ['gainers', 'losers', 'actives'] },
        count: { type: 'number', description: 'How many to return, 1–25 (default 10).' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'get_quotes') return getQuotes(args.symbols);
  if (name === 'price_history') return priceHistory(args);
  if (name === 'top_movers') return topMovers(args);
  if (name !== 'market_snapshot') throw new Error(`Unknown tool: ${name}`);
  const region = typeof args.region === 'string' ? args.region.toLowerCase().trim() : 'headline';
  return marketSnapshot(region);
}

const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

/**
 * Why ONE symbol is missing, in words the caller can act on.
 *
 * price_history fans out over N symbols, so a partial answer is the normal
 * shape, not the exception — and a partial answer is only honest if the caller
 * can tell WHICH entity is absent and WHY. Fleet #1314: a four-index question
 * came back covering less than it was asked for and the miss read as a gap in
 * coverage rather than as a named, explained absence.
 *
 * Two rules, both learned the expensive way:
 *
 *  - NAME THE SYMBOL in every message. The reason travels inside a per-symbol
 *    row, so it is tempting to leave the symbol implicit — but these strings get
 *    quoted upwards by the calling model into prose where the row is gone, and
 *    "no data in range" attached to nothing is what turns a 3-of-4 answer into
 *    an apparent total failure.
 *  - A VENDOR STRING IS NOT A REASON. "Yahoo chart HTTP 404" tells a caller
 *    nothing about what to do; "does not recognise that symbol — indices need
 *    the ^ prefix" tells them to fix the ticker. The vendor text is kept, but
 *    subordinated to the sentence, never used as the whole explanation.
 *
 * Pure and total so it can be tested without the network.
 */
export function priceHistoryMissReason(
  symbol: string,
  kind: 'http' | 'empty' | 'no-trading-days' | 'thrown',
  detail?: string | number,
): string {
  const sym = String(symbol || 'that symbol');
  if (kind === 'http') {
    const status = Number(detail);
    if (status === 404 || status === 400) {
      return `We could not price "${sym}": Yahoo Finance does not recognise that symbol. Index symbols need the ^ prefix (^GSPC S&P 500, ^IXIC Nasdaq Composite, ^DJI Dow, ^SOX Philadelphia Semiconductor) — check the ticker and ask again.`;
    }
    if (status === 429) {
      return `We could not price "${sym}" right now: the price source is rate-limiting us. This is temporary and says nothing about the symbol — retry shortly.`;
    }
    return `We could not price "${sym}" right now: the price source returned an error (HTTP ${Number.isFinite(status) ? status : 'unknown'}). This is an upstream outage, not a missing symbol — retry shortly.`;
  }
  if (kind === 'empty') {
    const vendor = typeof detail === 'string' && detail.trim() ? ` (source said: ${detail.trim().slice(0, 120)})` : '';
    return `We could not price "${sym}" over the dates asked: the price source returned no trading days in that window. The symbol may be unknown or delisted, or the market may have been closed for the whole period${vendor}.`;
  }
  if (kind === 'no-trading-days') {
    return `"${sym}" is a known symbol, but ${detail ?? 'the dates asked'} contain no trading day for it — that window is a weekend, a holiday, or before the symbol started trading. Ask for a nearby trading date instead.`;
  }
  const why = typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 120) : 'the request did not complete';
  return `We could not price "${sym}" right now: the lookup failed before any data came back (${why}). This is a transient fetch failure, not a missing symbol — retry shortly.`;
}

// Historical daily closes + computed daily returns, per symbol, from Yahoo's
// keyless v8 chart endpoint. Exists because "closing prices and daily returns
// for four indices on August 7" had NO servable tool: get_quotes is
// current-only and tiingo has no index data, so the question 404'd four ways
// (Bruce's multi-lookup example, 2026-08-13). The fetch window is padded a
// week back so the previous trading close — required for the daily return —
// is always present even across weekends and holidays.
async function priceHistory(args: Record<string, unknown>): Promise<unknown> {
  const list = (Array.isArray(args.symbols) ? args.symbols : String(args.symbols ?? '').split(','))
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 8);
  if (list.length === 0) throw new Error('Pass one or more Yahoo Finance symbols, e.g. {symbols: ["^GSPC","^IXIC"], start_date: "2026-08-07"}.');
  const startStr = String(args.start_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr)) throw new Error('start_date must be YYYY-MM-DD, e.g. "2026-08-07".');
  const endStr = String(args.end_date ?? startStr).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endStr)) throw new Error('end_date must be YYYY-MM-DD.');
  const startMs = Date.parse(`${startStr}T00:00:00Z`);
  const endMs = Date.parse(`${endStr}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) throw new Error('Invalid date range: end_date is before start_date.');
  // Pad 7 days back for the prior close; 1 day forward so the end date's own
  // bar (stamped at market open in exchange-local time) is inside the window.
  const period1 = Math.floor(startMs / 1000) - 7 * 86400;
  const period2 = Math.floor(endMs / 1000) + 86400 + 86400;

  const results = await Promise.all(list.map(async (symbol) => {
    try {
      const url = `${CHART}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
      } finally { clearTimeout(t); }
      if (!res.ok) return { symbol, found: false, error: priceHistoryMissReason(symbol, 'http', res.status) };
      const data = await res.json() as { chart?: { result?: { meta?: { currency?: string; exchangeName?: string; symbol?: string }; timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[]; error?: { description?: string } } };
      const r = data.chart?.result?.[0];
      if (!r?.timestamp?.length) return { symbol, found: false, error: priceHistoryMissReason(symbol, 'empty', data.chart?.error?.description) };
      const closes = r.indicators?.quote?.[0]?.close ?? [];
      // Collapse to (date, close) pairs — the bar timestamp is market open in
      // exchange-local time; the UTC date of that instant is the trading date.
      const bars: { date: string; close: number }[] = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const c = closes[i];
        if (c == null) continue;
        bars.push({ date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), close: c });
      }
      const days = bars
        .map((b, i) => ({
          date: b.date,
          close: Number(b.close.toFixed(4)),
          previous_close: i > 0 ? Number(bars[i - 1].close.toFixed(4)) : null,
          daily_return_pct: i > 0 && bars[i - 1].close !== 0
            ? Number(((b.close / bars[i - 1].close - 1) * 100).toFixed(3))
            : null,
        }))
        .filter((d) => d.date >= startStr && d.date <= endStr);
      if (days.length === 0) return { symbol, found: false, error: priceHistoryMissReason(symbol, 'no-trading-days', `${startStr} to ${endStr}`) + ` Nearest earlier close the source returned: ${bars.at(-1)?.date ?? 'none'}.` };
      return { symbol, found: true, currency: r.meta?.currency ?? null, exchange: r.meta?.exchangeName ?? null, days };
    } catch (e) {
      return { symbol, found: false, error: priceHistoryMissReason(symbol, 'thrown', (e as Error).message) };
    }
  }));

  // Say the partial part OUT LOUD. `requested` vs `lookups` already implied it,
  // but implying it means the caller has to diff two arrays to notice — and the
  // model reading this payload writes prose from whatever is stated, so an
  // unstated absence becomes an unmentioned one. Fleet #1314: three of four
  // indices were available and the answer read as nothing. Additive: `results`
  // is unchanged, so an existing caller reads exactly what it read before.
  const missing = results
    .filter((r) => !r.found)
    .map((r) => ({ symbol: r.symbol, reason: (r as { error?: string }).error ?? 'no reason recorded' }));
  return {
    start_date: startStr,
    end_date: endStr,
    requested: list.length,
    // One underlying data request per symbol — the billing lane's per-lookup
    // metering signal (same rule as ask_pipeworx's billable_lookups).
    lookups: results.filter((r) => r.found).length,
    ...(missing.length
      ? {
          partial: true,
          missing,
          partial_note: `Answered ${list.length - missing.length} of the ${list.length} symbols asked for. The rest are listed in "missing" with the reason each one could not be priced — report those as named gaps. Do NOT drop them silently and do NOT substitute a different symbol.`,
        }
      : {}),
    results,
    source: 'Yahoo Finance (keyless)',
    note: 'daily_return_pct is close-over-previous-close; the previous close is included even when it falls before start_date.',
  };
}

async function getQuotes(rawSymbols: unknown): Promise<unknown> {
  const list = (Array.isArray(rawSymbols) ? rawSymbols : String(rawSymbols ?? '').split(','))
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 40);
  if (!list.length) {
    throw new Error('get_quotes requires "symbols" — one or more Yahoo Finance symbols, e.g. ["^NDX","AAPL","^GSPC"].');
  }
  const quotes = await fetchSpark(list);
  const results = list.map((symbol) => {
    const q = quotes.get(symbol) ?? null;
    const price = q?.price ?? null;
    const prev = q?.previous_close ?? null;
    const change = price != null && prev != null ? Number((price - prev).toFixed(4)) : null;
    const change_pct = price != null && prev ? Number((((price - prev) / prev) * 100).toFixed(2)) : null;
    return { symbol, price, previous_close: prev, change, change_pct, found: q != null && price != null };
  });
  return { requested: list.length, found: results.filter((r) => r.found).length, quotes: results };
}

interface Quote { price: number | null; previous_close: number | null }

async function fetchSpark(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  // chunk into ≤20 per call, fetch chunks in parallel
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += SPARK_MAX) chunks.push(symbols.slice(i, i + SPARK_MAX));

  const results = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const url = `${SPARK}?symbols=${chunk.map(encodeURIComponent).join(',')}&range=1d&interval=1d`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
        if (!res.ok) throw await httpError(res, 'Yahoo spark');
        const j = (await res.json()) as {
          spark?: { result?: { symbol?: string; response?: { meta?: { symbol?: string; regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number } }[] }[] };
        };
        for (const r of j.spark?.result ?? []) {
          const meta = r.response?.[0]?.meta;
          const sym = meta?.symbol ?? r.symbol;
          if (!sym) continue;
          out.set(sym, {
            price: meta?.regularMarketPrice ?? null,
            previous_close: meta?.chartPreviousClose ?? meta?.previousClose ?? null,
          });
        }
      } finally {
        clearTimeout(t);
      }
    }),
  );
  if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
    const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    throw new Error(`upstream_down: Yahoo Finance unreachable — ${first?.reason instanceof Error ? first.reason.message : 'all requests failed'}`);
  }
  return out;
}

function selectGroups(region: string): GroupDef[] {
  if (region === 'all') return GROUPS;
  if (region === 'headline' || region === '') {
    const bySym = new Map(GROUPS.flatMap((g) => g.items).map((i) => [i.symbol, i]));
    return [{
      key: 'headline', label: 'Market Snapshot (overnight)',
      items: HEADLINE_SYMBOLS.map((s) => bySym.get(s)).filter((i): i is Instrument => !!i),
    }];
  }
  const g = GROUPS.find((x) => x.key === region);
  if (!g) throw new Error(`Unknown region "${region}". Use one of: headline, all, ${REGION_KEYS.join(', ')}.`);
  return [g];
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

async function marketSnapshot(region: string) {
  const groups = selectGroups(region);
  const symbols = [...new Set(groups.flatMap((g) => g.items.map((i) => i.symbol)))];
  const quotes = await fetchSpark(symbols);

  const grouped = groups.map((g) => {
    const instruments = g.items.map((i) => {
      const q = quotes.get(i.symbol);
      const price = q?.price ?? null;
      const prev = q?.previous_close ?? null;
      const change = price != null && prev != null ? round(price - prev, 4) : null;
      const change_pct = price != null && prev != null && prev !== 0 ? round(((price - prev) / prev) * 100, 2) : null;
      return { symbol: i.symbol, name: i.name, price, previous_close: prev, change, change_pct };
    });
    const moves = instruments.filter((x) => x.change_pct != null);
    const up = moves.filter((x) => (x.change_pct as number) > 0).length;
    const down = moves.filter((x) => (x.change_pct as number) < 0).length;
    return { region: g.label, key: g.key, advancers: up, decliners: down, instruments };
  });

  const missing = groups.flatMap((g) => g.items).filter((i) => !quotes.get(i.symbol)?.price).map((i) => i.symbol);

  return {
    as_of: new Date().toISOString(),
    region,
    note: 'Prices are the latest available from Yahoo Finance; change is vs the previous close. Yields (^TNX etc.) are in percent; FX pairs are exchange rates; futures (ES=F, CL=F…) trade nearly 24h. Synthesize the recap from these numbers.',
    groups: grouped,
    ...(missing.length ? { unavailable_symbols: missing } : {}),
  };
}

const SCREENER = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved';
const MOVER_IDS: Record<string, string> = { gainers: 'day_gainers', losers: 'day_losers', actives: 'most_actives' };

async function topMovers(args: Record<string, unknown>): Promise<unknown> {
  const category = typeof args.category === 'string' && MOVER_IDS[args.category.toLowerCase()] ? args.category.toLowerCase() : 'gainers';
  const count = Math.min(25, Math.max(1, Number(args.count) || 10));
  const url = `${SCREENER}?scrIds=${MOVER_IDS[category]}&count=${count}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let data: { finance?: { result?: Array<{ quotes?: Array<Record<string, unknown>> }> } };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw await httpError(res, 'Yahoo screener');
    data = (await res.json()) as typeof data;
  } finally {
    clearTimeout(timer);
  }
  const quotes = data.finance?.result?.[0]?.quotes ?? [];
  const round = (v: unknown) => (typeof v === 'number' ? Number(v.toFixed(2)) : null);
  const movers = quotes.slice(0, count).map((q, i) => ({
    rank: i + 1,
    symbol: q.symbol ?? null,
    name: (q.shortName ?? q.longName ?? null) as string | null,
    price: round(q.regularMarketPrice),
    change: round(q.regularMarketChange),
    change_pct: round(q.regularMarketChangePercent),
    volume: typeof q.regularMarketVolume === 'number' ? q.regularMarketVolume : null,
    exchange: q.fullExchangeName ?? q.exchange ?? null,
  }));
  return {
    category,
    label: category === 'gainers' ? 'Top US gainers (by % change)' : category === 'losers' ? 'Top US losers (by % change)' : 'Most active US stocks (by volume)',
    as_of: new Date().toISOString(),
    count: movers.length,
    movers,
    source: 'Yahoo Finance predefined screener (keyless)',
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
