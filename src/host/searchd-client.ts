/**
 * Thin transport to guest `/svc/searchd` — serviceCall only.
 *
 * Production path is the stamped searchd binary in search-atlas via serviceCall.
 */

import {
  decodeSearchdResponse,
  encodeSearchdRequest,
  type SearchdRequest,
  type SearchdResponse,
} from "../protocol/searchd.js";
import { SEARCHD_SERVICE_NAME } from "../protocol/versions.js";

/** Product-canonical guest state directory. */
export const SEARCHD_GUEST_DIR = "/var/searchd";

/** Minimal VM surface required by this client. */
export interface SearchdVm {
  serviceCall(name: string, req: Uint8Array): Promise<Uint8Array>;
  fs?: {
    write?(path: string, data: string | Uint8Array): Promise<void> | void;
    read?(path: string): Promise<Uint8Array | string> | Uint8Array | string;
    mkdir?(path: string, recursive?: boolean): Promise<void> | void;
  };
}

export type SearchdTransportMode = "serviceCall";

/** Default timeouts by op — crawl steps need more headroom than queries. */
export function defaultTimeoutFor(request: SearchdRequest): number {
  switch (request.op) {
    case "crawl_step":
    case "embed_step":
    case "refresh":
    case "configure":
      return 120_000;
    case "query":
      return 30_000;
    default:
      return 60_000;
  }
}

export class SearchdClient {
  private readonly mode: SearchdTransportMode = "serviceCall";
  /** Single-flight queue so concurrent callers do not interleave serviceCalls. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly vm: SearchdVm, _mode: SearchdTransportMode | "auto" = "serviceCall") {
    // Mode argument accepted for call-site compatibility; only serviceCall is supported.
    void _mode;
  }

  get transport(): SearchdTransportMode {
    return this.mode;
  }

  async call(request: SearchdRequest, timeoutMs?: number): Promise<SearchdResponse> {
    const limit = timeoutMs ?? defaultTimeoutFor(request);
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {
      /* prior failure must not block the queue */
    });

    const work = this.dispatch(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`searchd call timed out after ${limit}ms`)),
            limit,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await work.then(
        () => undefined,
        () => undefined,
      );
      release();
    }
  }

  private async dispatch(request: SearchdRequest): Promise<SearchdResponse> {
    if (typeof this.vm.serviceCall !== "function") {
      throw new Error("vm.serviceCall is not available — search-atlas requires /svc/searchd");
    }
    const bytes = encodeSearchdRequest(request);
    const raw = await this.vm.serviceCall(SEARCHD_SERVICE_NAME, bytes);
    return decodeSearchdResponse(raw);
  }
}
