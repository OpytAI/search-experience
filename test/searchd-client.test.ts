/**
 * SearchdClient: serviceCall-only, serialization, timeouts.
 */
import { assert } from "./assert.ts";
import {
  encodeSearchdResponse,
  decodeSearchdRequest,
} from "../src/protocol/searchd.ts";
import { SearchdClient, defaultTimeoutFor } from "../src/host/searchd-client.ts";
import { SearchWorkerClient } from "../src/host/worker-client.ts";

assert(defaultTimeoutFor({ v: 1, op: "crawl_step", id: "c" }) >= 120_000, "crawl timeout");
assert(defaultTimeoutFor({ v: 1, op: "query", id: "q", collectionId: "d", query: "x" }) <= 30_000, "query timeout");
assert(defaultTimeoutFor({ v: 1, op: "status", id: "s" }) === 60_000, "default status timeout");

{
  let concurrent = 0;
  let maxConcurrent = 0;
  let inFlight = 0;
  const okStatus = (id: string) =>
    encodeSearchdResponse({
      v: 1,
      id,
      ok: true,
      op: "status",
      status: {
        phase: "lexical_ready",
        lexicalReady: true,
        semanticReady: false,
        collections: [],
      },
    });
  const client = new SearchdClient({
    async serviceCall(_name, req) {
      concurrent += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 40));
      concurrent -= 1;
      inFlight -= 1;
      const decoded = decodeSearchdRequest(req);
      return okStatus(decoded.id);
    },
  });
  await Promise.all([
    client.call({ v: 1, op: "status", id: "1" }, 5_000),
    client.call({ v: 1, op: "status", id: "2" }, 5_000),
    client.call({ v: 1, op: "status", id: "3" }, 5_000),
  ]);
  assert(maxConcurrent === 1, "searchd client serializes serviceCall calls");
  assert(inFlight === 0, "no leftover in-flight after queue drains");

  let timedOut = false;
  const slow = new SearchdClient({
    async serviceCall(_name, req) {
      inFlight += 1;
      await new Promise((r) => setTimeout(r, 80));
      inFlight -= 1;
      const decoded = decodeSearchdRequest(req);
      return okStatus(decoded.id);
    },
  });
  try {
    await slow.call({ v: 1, op: "status", id: "slow" }, 20);
  } catch {
    timedOut = true;
  }
  assert(timedOut, "timeout rejects caller");
  await slow.call({ v: 1, op: "status", id: "after" }, 5_000);
  assert(inFlight === 0, "mutex held until dispatch settled after timeout");
}

{
  let serviceCalls = 0;
  const client = new SearchdClient({
    async serviceCall(_name, req) {
      serviceCalls += 1;
      const decoded = decodeSearchdRequest(req);
      return encodeSearchdResponse({
        v: 1,
        id: decoded.id,
        ok: true,
        op: decoded.op,
        status: {
          phase: "lexical_ready",
          lexicalReady: true,
          semanticReady: false,
          collections: [],
        },
      });
    },
  });
  const res = await client.call({ v: 1, op: "status", id: "svc-1" }, 5_000);
  assert(res.ok === true, "serviceCall ok");
  assert(serviceCalls === 1, "serviceCall used");
  assert(client.transport === "serviceCall", "transport is serviceCall");
}

{
  let threw = false;
  const client = new SearchdClient({
    // @ts-expect-error intentional missing serviceCall for runtime guard
    serviceCall: undefined,
  });
  try {
    await client.call({ v: 1, op: "status", id: "x" }, 1_000);
  } catch (e) {
    threw = e instanceof Error && e.message.includes("serviceCall");
  }
  assert(threw, "missing serviceCall fails closed");
}

{
  const posted: unknown[] = [];
  const fakeWorker = {
    postMessage(msg: unknown) {
      posted.push(msg);
    },
    addEventListener() {},
  } as unknown as Worker;
  const client = new SearchWorkerClient(fakeWorker);
  const ac = new AbortController();
  const searchPromise = client.makeProviderCollections([{
    id: "docs",
    label: "Docs",
    capabilities: ["lexical"],
  }])[0]!.search({
    query: "x",
    mode: "",
    limit: 5,
    signal: ac.signal,
  });
  ac.abort();
  let aborted = false;
  try {
    await searchPromise;
  } catch (e) {
    aborted = e instanceof DOMException && e.name === "AbortError";
  }
  assert(aborted, "abort rejects search");
  assert(posted.some((m) => (m as { type?: string }).type === "cancel"), "cancel message posted");
}

console.log("searchd-client.test.ts: ok");
