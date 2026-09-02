/* Sedra Electric — chatbot stats (Cloudflare Pages Function)
   Route: GET /api/stats            (optionally ?key=YOUR_KEY)
   Aggregates leads + chat transcripts SERVER-SIDE from Firebase and returns
   counts only, so the raw data is never exposed to the browser.

   Optional env vars:
     LEAD_DB_URL  Firebase RTDB base url (default below)
     LEAD_NODE    leads node (default "leads")
     CHATS_NODE   chats node (default "chats")
     STATS_KEY    if set, /api/stats?key=... must match (gate the dashboard)
     FB_SECRET    Firebase auth (DB secret / token) if you lock the database */

const DB_DEFAULT = "https://sedra-crm-default-rtdb.firebaseio.com";
function cors(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};}
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...cors()}});}

export function onRequestOptions(){return new Response(null,{headers:cors()});}

export async function onRequestGet(context){
  const { request, env } = context;
  try{
    const url = new URL(request.url);
    // Fail closed: the stats read real lead/chat counts, so they must NEVER be public.
    // Access requires STATS_KEY to be configured AND matched. No key set = no access.
    if(!env.STATS_KEY || url.searchParams.get('key') !== env.STATS_KEY){
      return json({ ok:false, error:"unauthorized" }, 401);
    }
    const DB   = env.LEAD_DB_URL || DB_DEFAULT;
    const auth = env.FB_SECRET ? ('?auth='+encodeURIComponent(env.FB_SECRET)) : '';
    const leadsNode = env.LEAD_NODE || "leads";
    const chatsNode = env.CHATS_NODE || "chats";

    const [lr, cr] = await Promise.all([
      fetch(`${DB}/${leadsNode}.json${auth}`).then(r=>r.ok?r.json():null).catch(()=>null),
      fetch(`${DB}/${chatsNode}.json${auth}`).then(r=>r.ok?r.json():null).catch(()=>null)
    ]);

    const dayKey = (ts)=> new Date(ts).toISOString().slice(0,10);
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = Date.now() - 7*86400000;

    let totalLeads=0, leadsToday=0, leads7d=0; const svc={};
    if(lr && typeof lr==='object'){
      for(const k in lr){ const L=lr[k]||{}; totalLeads++;
        const ts = L.ts || Date.parse(L.created||L.createdAt||'') || 0;
        if(ts && ts>=weekAgo) leads7d++;
        if((L.date||dayKey(ts))===today) leadsToday++;
        const s=(L.service||'').trim(); if(s) svc[s]=(svc[s]||0)+1;
      }
    }
    let totalChats=0, chatsToday=0, totalTurns=0;
    if(cr && typeof cr==='object'){
      for(const k in cr){ const C=cr[k]||{}; totalChats++;
        totalTurns += (C.turns||(Array.isArray(C.messages)?C.messages.length:0));
        const ts=C.ts||Date.parse(C.updated||'')||0;
        if(dayKey(ts)===today) chatsToday++;
      }
    }
    const topServices = Object.entries(svc).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([name,count])=>({name,count}));

    return json({ ok:true, updated:new Date().toISOString(),
      leads:{ total:totalLeads, today:leadsToday, last7d:leads7d },
      chats:{ total:totalChats, today:chatsToday, avgTurns: totalChats? Math.round(totalTurns/totalChats):0 },
      topServices });
  }catch(e){
    return json({ ok:false, error:String(e&&e.message||e) }, 500);
  }
}
