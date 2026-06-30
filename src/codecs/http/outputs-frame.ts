/**
 * @module
 * `httpOutputsFrame` — the default HTTP batch codec. Packages today's
 * baked behavior as an explicit, operator-declared codec.
 *
 * Wire shape:
 *   - **read response:** `application/octet-stream` framed by
 *     `outputs-frame` (`../outputs-frame.ts`). One slot per result;
 *     `<flag><uri><payload>` per slot. Bytes verbatim on flag=1; JSON
 *     fallback on flag=0.
 *   - **receive body:** `application/octet-stream` carrying
 *     `bytes-list` framed payloads (lenSize=4), paired position-wise
 *     with the URIs in the `?u=` query (`../url-list.ts`).
 *
 * Stream payloads from upstream stores (`b3nd-save` fs/s3/ipfs or
 * custom PINs whose backing medium streams) are materialized to
 * `Uint8Array` per slot inside this codec — the outputs-frame is a
 * concrete-shape codec, so materialization owns the question "make
 * every slot a concrete payload" at the layer that actually requires
 * it.
 *
 * Materialization runs through a `Scheduler` (default `Promise.all`);
 * hosts that need fan-out caps inject one at construction:
 * `httpOutputsFrame({ scheduler: pLimitTo4 })`.
 *
 * The dispatcher's per-request `AbortSignal` flows into the stream
 * pump via `pipeTo({ signal })`, so an aborted request cancels stream
 * consumption at chunk boundaries.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { HttpBatchCodec } from "../../http/codec.ts";
import { decodeOutputsFrame, encodeOutputsFrame } from "../outputs-frame.ts";
import { decodeUrlList } from "../url-list.ts";
import { decodeBytesList } from "../bytes-list.ts";
import { defaultScheduler, type Scheduler } from "../scheduler.ts";

export interface HttpOutputsFrameOptions {
  /** Fan-out scheduler for per-slot stream materialization. Defaults to `Promise.all`. */
  scheduler?: Scheduler;
}

export function httpOutputsFrame(
  opts: HttpOutputsFrameOptions = {},
): HttpBatchCodec {
  const scheduler = opts.scheduler ?? defaultScheduler;
  return {
    async encode(outputs, ctx): Promise<Response> {
      const concrete = await materializeAll(outputs, scheduler, ctx.signal);
      // Cast around lib.dom's `BodyInit` not accepting
      // `Uint8Array<ArrayBufferLike>` for typed-array bodies.
      return new Response(
        encodeOutputsFrame(concrete) as unknown as BodyInit,
        {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        },
      );
    },
    async decode(req): Promise<Output[]> {
      const u = new URL(req.url).searchParams.get("u");
      if (!u) {
        throw new TypeError("httpOutputsFrame.decode: Missing ?u= URI list");
      }
      const uris = decodeUrlList(u);
      const body = new Uint8Array(await req.arrayBuffer());
      const payloads = decodeBytesList(body, { lenSize: 4 });
      if (payloads.length !== uris.length) {
        throw new TypeError(
          `httpOutputsFrame.decode: Payload count (${payloads.length}) does not match URI count (${uris.length})`,
        );
      }
      return uris.map((uri, i) => [uri, payloads[i]]);
    },
    async decodeReadResponse(res): Promise<Output[]> {
      const buf = new Uint8Array(await res.arrayBuffer());
      return decodeOutputsFrame(buf);
    },
  };
}

function materializeAll(
  outputs: readonly Output[],
  scheduler: Scheduler,
  signal: AbortSignal,
): Promise<Output[]> {
  const slots = outputs.map(
    ([uri, payload]) => async (slotSignal: AbortSignal): Promise<Output> => {
      if (
        payload &&
        typeof payload === "object" &&
        typeof (payload as ReadableStream<Uint8Array>).getReader === "function"
      ) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        await (payload as ReadableStream<Uint8Array>).pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              chunks.push(chunk);
              total += chunk.byteLength;
            },
          }),
          { signal: slotSignal },
        );
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        return [uri, merged];
      }
      return [uri, payload];
    },
  );
  return scheduler(slots, signal);
}
