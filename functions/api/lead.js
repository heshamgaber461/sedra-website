/* Sedra Electric — lead capture (Cloudflare Pages Function)
   Route: POST /api/lead
   Saves the lead into the Firebase Realtime Database `leads` node in the exact
   shape the Sedra CRM expects, so chat leads appear inside the CRM leads list.
   Optional env vars: LEAD_BRANCH (default "Egypt"), LEAD_NODE (default "leads"). */

const DB_URL = "https://sedra-crm-default-rtdb.firebaseio.com";

function cors(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};}
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...cors()}});}
const clip=(v,n)=>(v==null?'':String(v)).trim().slice(0,n);

export function onRequestOptions(){return new Response(null,{headers:cors()});}

export async function onRequestPost(context){
  const { request, env } = context;
  try{
    const b = await request.json().catch(()=>({}));
    const phone = clip(b.phone,30);
    if(phone.replace(/\D/g,'').length < 7){ return json({ok:false, error:"valid phone required"}, 400); }
    const node   = (env && env.LEAD_NODE)   ? env.LEAD_NODE   : "leads";
    const branch = (env && env.LEAD_BRANCH) ? env.LEAD_BRANCH : "Egypt";
    const nowIso = new Date().toISOString();
    const name = clip(b.name,80) || phone;   /* CRM needs a name; fall back to phone */
    const city = clip(b.city,40);
    const note = clip(b.message,500);
    /* shape matches the CRM lead schema (name, phone, branch, stage, source, notes, created…) */
    const lead = {
      name,
      phone,
      email: "",
      branch,
      stage: "New",
      source: "Website Chatbot",
      service: clip(b.service,60),
      area: city,
      city: city,
      notes: note,
      note: note,
      owner: "",
      lang: clip(b.lang,4),
      created: nowIso,
      createdAt: nowIso,
      date: nowIso.slice(0,10),
      ts: Date.now()
    };
    const r = await fetch(`${DB_URL}/${node}.json`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(lead)
    });
    if(!r.ok){ return json({ok:false, error:"db "+r.status}, 502); }
    return json({ ok:true });
  }catch(e){
    return json({ ok:false, error: String(e && e.message || e) }, 500);
  }
}
