export const API_CLIENT_REQUEST_MESSAGE_TYPE = "API_CLIENT_REQUEST";
export const API_CLIENT_CANCEL_MESSAGE_TYPE = "API_CLIENT_CANCEL";
export const API_CLIENT_RESPONSE_MESSAGE_TYPE = "API_CLIENT_RESPONSE";
export const MAX_API_CLIENT_RESPONSE_BYTES = 1024 * 1024;
/** Lower durable cap for each response copied into history or a recording. */
export const MAX_API_CLIENT_RETAINED_BODY_BYTES = 256 * 1024;

export interface ApiClientRequestPayload {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface ApiClientResponsePayload {
  id: string;
  ok: true;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  durationMs: number;
  truncated?: boolean;
  bodyBytes?: number;
}

export interface ApiClientErrorPayload {
  id: string;
  ok: false;
  error: string;
  durationMs: number;
}

export type ApiClientResultPayload = ApiClientResponsePayload | ApiClientErrorPayload;

const MAX_API_CLIENT_ERROR_LENGTH = 8 * 1024;
const MAX_API_CLIENT_RESPONSE_HEADERS = 200;
const MAX_API_CLIENT_HEADER_NAME_LENGTH = 256;
const MAX_API_CLIENT_HEADER_VALUE_LENGTH = 4 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export interface TruncatedUtf8String {
  value: string;
  byteLength: number;
  truncated: boolean;
}

/** Truncate without splitting a surrogate pair and account in UTF-8 bytes, not JS code units. */
export function truncateUtf8(value: string, maxBytes: number): TruncatedUtf8String {
  const limit = Math.max(0, Math.trunc(maxBytes));
  let byteLength = 0;
  let end = 0;

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index) ?? 0;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const nextBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

    if (byteLength + nextBytes > limit) {
      break;
    }

    byteLength += nextBytes;
    index += codeUnits;
    end = index;
  }

  return {
    value: end === value.length ? value : value.slice(0, end),
    byteLength,
    truncated: end < value.length,
  };
}

/** Validate and independently bound messages supplied by the preview frame. */
export function normalizeApiClientResultPayload(value: unknown): ApiClientResultPayload | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    typeof value.durationMs !== "number"
  ) {
    return null;
  }

  const durationMs = Number.isFinite(value.durationMs) ? Math.max(0, value.durationMs) : 0;

  if (value.ok === false) {
    return typeof value.error === "string"
      ? {
          id: value.id,
          ok: false,
          error: value.error.slice(0, MAX_API_CLIENT_ERROR_LENGTH),
          durationMs,
        }
      : null;
  }

  if (
    value.ok !== true ||
    typeof value.status !== "number" ||
    !Number.isFinite(value.status) ||
    typeof value.statusText !== "string" ||
    typeof value.body !== "string" ||
    !Array.isArray(value.headers)
  ) {
    return null;
  }

  const headers: [string, string][] = [];
  for (const header of value.headers.slice(0, MAX_API_CLIENT_RESPONSE_HEADERS)) {
    if (Array.isArray(header) && typeof header[0] === "string" && typeof header[1] === "string") {
      headers.push([
        header[0].slice(0, MAX_API_CLIENT_HEADER_NAME_LENGTH),
        header[1].slice(0, MAX_API_CLIENT_HEADER_VALUE_LENGTH),
      ]);
    }
  }

  const body = truncateUtf8(value.body, MAX_API_CLIENT_RESPONSE_BYTES);
  return {
    id: value.id,
    ok: true,
    status: Math.trunc(value.status),
    statusText: value.statusText.slice(0, 1024),
    headers,
    body: body.value,
    durationMs,
    truncated: value.truncated === true || body.truncated,
    bodyBytes:
      typeof value.bodyBytes === "number" && Number.isFinite(value.bodyBytes)
        ? Math.max(0, Math.min(MAX_API_CLIENT_RESPONSE_BYTES, Math.trunc(value.bodyBytes)))
        : body.byteLength,
  };
}

export function createApiClientProxyScript(setupMarker: string): string {
  return `(function(){var marker=${JSON.stringify(setupMarker)};if(window[marker])return;window[marker]=true;
var reqType=${JSON.stringify(API_CLIENT_REQUEST_MESSAGE_TYPE)};
var cancelType=${JSON.stringify(API_CLIENT_CANCEL_MESSAGE_TYPE)};
var resType=${JSON.stringify(API_CLIENT_RESPONSE_MESSAGE_TYPE)};
var maxBytes=${MAX_API_CLIENT_RESPONSE_BYTES};
var controllers=new Map();
function post(payload){window.parent.postMessage({type:resType,payload:payload},"*");}
async function readBoundedBody(response){
  if(!response.body||typeof response.body.getReader!=="function")return{body:"",bodyBytes:0,truncated:false};
  var reader=response.body.getReader();var declared=Number(response.headers.get("content-length"));if(Number.isFinite(declared)&&declared>maxBytes){await reader.cancel("declared response exceeds limit");reader.releaseLock();return{body:"",bodyBytes:0,truncated:true};}
  var decoder=new TextDecoder();var chunks=[];var bytes=0;var truncated=false;
  try{while(true){var part=await reader.read();if(part.done)break;var value=part.value;if(!value)continue;var remaining=maxBytes-bytes;if(value.byteLength>remaining){if(remaining>0){chunks.push(decoder.decode(value.subarray(0,remaining),{stream:true}));bytes+=remaining;}truncated=true;await reader.cancel("response limit reached");break;}chunks.push(decoder.decode(value,{stream:true}));bytes+=value.byteLength;if(bytes===maxBytes){var extra=await reader.read();if(!extra.done){truncated=true;await reader.cancel("response limit reached");}break;}}chunks.push(decoder.decode());return{body:chunks.join(""),bodyBytes:bytes,truncated:truncated};}finally{reader.releaseLock();}
}
window.addEventListener("message",function(e){
  if(e.source!==window.parent||!e.data)return;
  var payload=e.data.payload;
  if(e.data.type===cancelType){if(payload&&payload.id){var active=controllers.get(payload.id);if(active){controllers.delete(payload.id);active.abort();}}return;}
  if(e.data.type!==reqType||!payload||!payload.id)return;
  var p=payload;var started=performance.now();var controller=new AbortController();controllers.set(p.id,controller);
  var headers=(typeof p.headers==="object"&&p.headers!==null)?p.headers:{};
  var body=(p.method==="GET"||p.method==="HEAD")?undefined:p.body;
  fetch(p.path,{method:p.method,headers:headers,body:body,signal:controller.signal}).then(async function(response){var result=await readBoundedBody(response);if(controller.signal.aborted)return;post({id:p.id,ok:true,status:response.status,statusText:response.statusText,headers:Array.from(response.headers.entries()),body:result.body,durationMs:performance.now()-started,truncated:result.truncated,bodyBytes:result.bodyBytes});}).catch(function(error){if(controller.signal.aborted)return;post({id:p.id,ok:false,error:String(error),durationMs:performance.now()-started});}).finally(function(){controllers.delete(p.id);});
});})();`;
}
