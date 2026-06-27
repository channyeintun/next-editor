export const API_CLIENT_REQUEST_MESSAGE_TYPE = "API_CLIENT_REQUEST";
export const API_CLIENT_RESPONSE_MESSAGE_TYPE = "API_CLIENT_RESPONSE";
// Parent → API client iframe: whether the runtime server is up and requests can
// be sent. The iframe toggles a "waiting for the server" banner / Send button.
export const API_CLIENT_READY_MESSAGE_TYPE = "API_CLIENT_READY";

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
}

export interface ApiClientErrorPayload {
  id: string;
  ok: false;
  error: string;
  durationMs: number;
}

export type ApiClientResultPayload = ApiClientResponsePayload | ApiClientErrorPayload;

export function createApiClientProxyScript(setupMarker: string): string {
  return `(function(){var marker=${JSON.stringify(
    setupMarker,
  )};if(window[marker])return;window[marker]=true;var reqType=${JSON.stringify(
    API_CLIENT_REQUEST_MESSAGE_TYPE,
  )};var resType=${JSON.stringify(
    API_CLIENT_RESPONSE_MESSAGE_TYPE,
  )};window.addEventListener("message",function(e){if(!e.data||e.data.type!==reqType)return;var p=e.data.payload;if(!p||!p.id)return;var started=performance.now();var hdrs;try{hdrs=typeof p.headers==="object"&&p.headers!==null?p.headers:{}}catch(x){hdrs={}}var body=(p.method==="GET"||p.method==="HEAD")?undefined:p.body;fetch(p.path,{method:p.method,headers:hdrs,body:body}).then(function(res){return res.text().then(function(text){window.parent.postMessage({type:resType,payload:{id:p.id,ok:true,status:res.status,statusText:res.statusText,headers:Array.from(res.headers.entries()),body:text,durationMs:performance.now()-started}},"*")})}).catch(function(err){window.parent.postMessage({type:resType,payload:{id:p.id,ok:false,error:String(err),durationMs:performance.now()-started}},"*")})});})();`;
}
